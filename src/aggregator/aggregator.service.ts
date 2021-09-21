import { Injectable, Logger } from '@nestjs/common';
import { DaoService } from 'src/daos/dao.service';
import { SputnikDaoService } from 'src/sputnikdao/sputnik.service';
import { ProposalService } from 'src/proposals/proposal.service';
import { isNotNull } from 'src/utils/guards';
import { NearService } from 'src/near/near.service';
import { TransactionService } from 'src/transactions/transaction.service';
import { ConfigService } from '@nestjs/config';
import { Transaction, Account } from 'src/near';
import { SputnikDaoDto } from 'src/daos/dto/dao-sputnik.dto';
import { castProposalKind, ProposalDto } from 'src/proposals/dto/proposal.dto';
import { SchedulerRegistry } from '@nestjs/schedule';
import { buildDaoId, buildProposalId } from 'src/utils';
import { EventService } from 'src/events/events.service';
import { DaoStatus } from 'src/daos/types/dao-status';
import { BountyService } from 'src/bounties/bounty.service';
import { TokenFactoryService } from 'src/token-factory/token-factory.service';
import { TokenDto } from 'src/tokens/dto/token.dto';
import { TokenService } from 'src/tokens/token.service';
import { BountyDto } from 'src/bounties/dto/bounty.dto';
import { ProposalKindAddBounty } from 'src/proposals/dto/proposal-kind.dto';
import { ProposalType } from 'src/proposals/types/proposal-type';

@Injectable()
export class AggregatorService {
  private readonly logger = new Logger(AggregatorService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly sputnikDaoService: SputnikDaoService,
    private readonly tokenFactoryService: TokenFactoryService,
    private readonly daoService: DaoService,
    private readonly proposalService: ProposalService,
    private readonly nearService: NearService,
    private readonly transactionService: TransactionService,
    private readonly eventService: EventService,
    private readonly bountyService: BountyService,
    private readonly tokenService: TokenService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {
    const { pollingInterval } = this.configService.get('aggregator');

    const interval = setInterval(
      () => this.scheduleAggregation(),
      pollingInterval,
    );
    schedulerRegistry.addInterval('polling', interval);
  }

  public async scheduleAggregation(): Promise<void> {
    const tx = await this.transactionService.lastTransaction();
    if (!tx) {
      // Skipping cron job scheduling until the very 1st aggregation completes.
      return;
    }

    return this.aggregate(tx);
  }

  public async aggregate(lastTx?: Transaction): Promise<void> {
    const { contractName, tokenFactoryContractName } =
      this.configService.get('near');

    this.logger.log('Scheduling Data Aggregation...');

    this.logger.log('Collecting DAO IDs...');
    const daoIds = await this.sputnikDaoService.getDaoIds();

    this.logger.log('Checking data relevance...');

    const tx = lastTx || (await this.transactionService.lastTransaction());

    const transactions: Transaction[] =
      await this.nearService.findTransactionsByReceiverAccountIds(
        [...daoIds, contractName, tokenFactoryContractName],
        tx?.blockTimestamp,
      );

    // Last transaction from NEAR Indexer - for the list of DAOs defined
    const { transactionHash: nearTransactionHash } =
      transactions?.[transactions?.length - 1] || {};

    if (tx && tx.transactionHash === nearTransactionHash) {
      return this.logger.log('Data is up to date. Skipping data aggregation.');
    }

    const accounts: Account[] =
      await this.nearService.findAccountsByContractName(contractName);

    let accountDaoIds = daoIds;
    let proposalDaoIds = daoIds;
    let tokenIds = null;

    const actionTransactions = transactions.filter(
      (tx) => tx.transactionAction.args.args_json,
    );

    // TODO: check token re-indexing condition - get delta

    if (tx) {
      accountDaoIds = [
        ...new Set(
          transactions
            //TODO: Q1: args_json is absent? - needs clarification
            .filter(
              ({ transactionAction: action }) =>
                action.args?.args_json && (action.args?.args_json as any)?.name,
            )
            .filter(
              ({ receiverAccountId: accId, transactionAction: action }) =>
                accId === contractName &&
                (action.args as any).method_name === 'create',
            )
            .map(({ transactionAction: action }) =>
              buildDaoId((action.args as any).args_json.name, contractName),
            ),
        ),
      ];

      if (accountDaoIds.length) {
        this.logger.log(`New DAOs created: ${accountDaoIds.join(',')}`);
      }

      //TODO: Re-work this for cases when proposal is created - there is no 'id' in transaction action payload
      const proposalTransactions = actionTransactions
        .filter(({ receiverAccountId }) => receiverAccountId !== contractName)
        .map(({ receiverAccountId, transactionAction: action }) => ({
          receiverAccountId,
          function: (action.args as any).method_name,
          id: buildProposalId(
            receiverAccountId,
            (action.args as any).args_json.id,
          ),
        }));

      proposalDaoIds = [
        ...new Set(
          proposalTransactions.map(
            ({ receiverAccountId }) => receiverAccountId,
          ),
        ),
      ];

      if (proposalTransactions.length) {
        this.logger.log(
          `Proposals updated for DAOs: ${proposalDaoIds.join(',')}`,
        );
        await this.eventService.handleDaoUpdates(proposalDaoIds);
      }

      const transactionsByAccountId =
        this.reduceTransactionsByAccountId(actionTransactions);

      const tokenFactoryTransactions =
        transactionsByAccountId[tokenFactoryContractName] || [];

      const tokenTransactions = tokenFactoryTransactions.filter(
        ({ transactionAction }) => {
          const { method_name, args_json } = transactionAction.args;
          const { metadata } = (args_json as any)?.args || {};

          return method_name == 'create_token' && metadata;
        },
      );

      tokenIds = [
        ...new Set(
          tokenTransactions.map((tx) => {
            const { symbol } = (tx.transactionAction.args.args_json as any)
              ?.args?.metadata;

            return symbol;
          }),
        ),
      ];
    }

    const bountyClaimAccountIds = [
      ...new Set(
        actionTransactions
          .filter(
            ({ transactionAction: action }) =>
              'bounty_claim' === (action.args as any).method_name,
          )
          .map(({ signerAccountId }) => signerAccountId),
      ),
    ];

    this.logger.log('Aggregating data...');
    const [daos, proposals, bounties, tokens] = await Promise.all([
      this.sputnikDaoService.getDaoList(
        Array.from(new Set([...accountDaoIds, ...proposalDaoIds])),
      ),
      this.sputnikDaoService.getProposals(proposalDaoIds),
      this.sputnikDaoService.getBounties(proposalDaoIds, bountyClaimAccountIds),
      this.tokenFactoryService.getTokens(tokenIds),
    ]);

    const enrichedDaos = this.enrichDaos(daos, accounts, transactions);
    const enrichedDaoIds = enrichedDaos.map(({ id }) => id);

    this.logger.log('Persisting aggregated DAOs...');
    await Promise.all(
      enrichedDaos
        .filter((dao) => isNotNull(dao))
        .map((dao) => this.daoService.create(dao)),
    );
    this.logger.log('Finished DAO aggregation.');

    //Q2: Proposals with the absent DAO references?
    //Filtering proposals for unavailable DAOs
    const filteredProposals = !tx
      ? proposals.filter(({ daoId }) => enrichedDaoIds.includes(daoId))
      : proposals;

    const enrichedProposals = this.enrichProposals(
      filteredProposals,
      transactions,
    );

    this.logger.log('Persisting aggregated Proposals...');
    await Promise.all(
      enrichedProposals.map((proposal) =>
        this.proposalService.create(proposal),
      ),
    );
    this.logger.log('Finished Proposals aggregation.');

    const filteredBounties = !tx
      ? bounties.filter(({ daoId }) => enrichedDaoIds.includes(daoId))
      : bounties;

    const enrichedBounties = this.enrichBounties(
      filteredBounties,
      transactions,
    );

    this.logger.log('Persisting aggregated Bounties...');
    await Promise.all(
      enrichedBounties.map((bounty) => this.bountyService.create(bounty)),
    );
    this.logger.log('Finished Bounties aggregation.');

    const enrichedTokens = this.enrichTokens(
      tokens,
      transactions,
      tokenFactoryContractName,
    );

    this.logger.log('Persisting aggregated Tokens...');
    await Promise.all(
      enrichedTokens.map((token) => this.tokenService.create(token)),
    );
    this.logger.log('Finished Tokens aggregation.');

    this.logger.log('Persisting aggregated Transactions...');
    await Promise.all(
      transactions.map((transaction) =>
        this.transactionService.create(transaction),
      ),
    );
  }

  private enrichDaos(
    daos: SputnikDaoDto[],
    accounts: Account[],
    transactions: Transaction[],
  ): SputnikDaoDto[] {
    const daoTxDataMap = accounts.reduce(
      (acc, { accountId, receipt }) => ({
        ...acc,
        [accountId]: {
          transactionHash: receipt.originatedFromTransactionHash,
          blockTimestamp: receipt.includedInBlockTimestamp,
        },
      }),
      {},
    );

    const signersByAccountId = transactions.reduce(
      (acc, cur) => ({
        ...acc,
        [cur.receiverAccountId]: [
          ...(acc[cur.receiverAccountId] || []),
          cur.signerAccountId,
        ],
      }),
      {},
    );

    const transactionsByAccountId =
      this.reduceTransactionsByAccountId(transactions);

    return daos.map((dao) => {
      const txData = daoTxDataMap[dao.id];
      const daoTxs = transactionsByAccountId[dao.id];
      const txUpdateData = daoTxs?.[daoTxs?.length - 1];

      return {
        ...dao,
        transactionHash: txData?.transactionHash,
        createTimestamp: txData?.blockTimestamp,
        updateTransactionHash: (txUpdateData || txData)?.transactionHash,
        updateTimestamp: (txUpdateData || txData)?.blockTimestamp,
        numberOfMembers: new Set(signersByAccountId[dao.id]).size,
        status: DaoStatus.Success,
        createdBy: daoTxs?.[0]?.signerAccountId,
      };
    });
  }

  private enrichProposals(
    proposals: ProposalDto[],
    transactions: Transaction[],
  ): ProposalDto[] {
    const transactionsByAccountId =
      this.reduceTransactionsByAccountId(transactions);

    return proposals.map((proposal) => {
      const { id, daoId, description, kind, proposer } = proposal;
      if (!transactionsByAccountId[daoId]) {
        return proposal;
      }

      const preFilteredTransactions = transactionsByAccountId[daoId].filter(
        (tx) => tx.transactionAction.args.args_json,
      );

      const txData = preFilteredTransactions
        .filter(
          ({ transactionAction }) =>
            (transactionAction.args as any).method_name == 'add_proposal',
        )
        .find((tx) => {
          const { signerAccountId } = tx;

          const { description: txDescription, kind: txKind } =
            (tx.transactionAction.args.args_json as any).proposal || {};
          return (
            description === txDescription &&
            kind.equals(castProposalKind(txKind)) &&
            signerAccountId === proposer
          );
        });

      const txUpdateData = preFilteredTransactions
        .filter((tx) => (tx.transactionAction.args.args_json as any).id === id)
        .pop();

      const prop = {
        ...proposal,
        transactionHash: txData?.transactionHash,
        createTimestamp: txData?.blockTimestamp,
        updateTransactionHash: (txUpdateData || txData)?.transactionHash,
        updateTimestamp: (txUpdateData || txData)?.blockTimestamp,
      };

      return prop;
    });
  }

  private enrichBounties(bounties: BountyDto[], transactions: Transaction[]) {
    const transactionsByAccountId =
      this.reduceTransactionsByAccountId(transactions);

    return bounties.map((bounty) => {
      const { daoId, amount, description, maxDeadline, times, token } = bounty;
      if (!transactionsByAccountId[daoId]) {
        return bounty;
      }

      const preFilteredTransactions = transactionsByAccountId[daoId].filter(
        (tx) => tx.transactionAction.args.args_json,
      );

      const txData = preFilteredTransactions
        .filter(
          ({ transactionAction }) =>
            (transactionAction.args as any).method_name == 'add_proposal',
        )
        .filter((tx) => {
          const { kind: txKind } =
            (tx.transactionAction.args.args_json as any).proposal || {};

          const txProposalKind = castProposalKind(txKind);
          const { type } = txProposalKind?.kind;
          if (ProposalType.AddBounty !== type) {
            return false;
          }

          const {
            amount: txAmount,
            description: txDescription,
            times: txTimes,
            maxDeadline: txMaxDeadline,
            token: txToken,
          } = (txProposalKind.kind as ProposalKindAddBounty)?.bounty || {};

          return (
            amount === txAmount &&
            description === txDescription &&
            times === txTimes &&
            maxDeadline === txMaxDeadline &&
            token === txToken
          );
        });

      const txCreateData = txData[0];
      const txUpdateData = txData[txData.length - 1];

      const bountyClaimTransactions = preFilteredTransactions.filter(
        ({ transactionAction }) =>
          (transactionAction.args as any).method_name == 'bounty_claim',
      );

      const bountyClaims = bounty.bountyClaims.map((bountyClaim) => {
        const { bounty, deadline, accountId } = bountyClaim;
        const txCreateData = bountyClaimTransactions.find((tx) => {
          const { signerAccountId } = tx;
          const { id: txId, deadline: txDeadline } = tx.transactionAction.args
            .args_json as any;

          return (
            signerAccountId === accountId &&
            bounty?.bountyId === txId &&
            deadline === txDeadline
          );
        });

        const enrichedBountyClaim = {
          ...bountyClaim,
          transactionHash: txCreateData?.transactionHash,
          createTimestamp: txCreateData?.blockTimestamp,
        };

        return enrichedBountyClaim;
      });

      const enrichedBounty = {
        ...bounty,
        bountyClaims,
        transactionHash: txCreateData?.transactionHash,
        createTimestamp: txCreateData?.blockTimestamp,
        updateTransactionHash: (txUpdateData || txCreateData)?.transactionHash,
        updateTimestamp: (txUpdateData || txCreateData)?.blockTimestamp,
      };

      return enrichedBounty;
    });
  }

  private enrichTokens(
    tokens: TokenDto[],
    transactions: Transaction[],
    tokenFactoryContractName: string,
  ): TokenDto[] {
    const transactionsByAccountId =
      this.reduceTransactionsByAccountId(transactions);

    const tokenFactoryTransactions =
      transactionsByAccountId[tokenFactoryContractName];

    if (!tokenFactoryTransactions || !tokenFactoryTransactions.length) {
      return tokens;
    }

    const preFilteredTransactions = tokenFactoryTransactions.filter(
      (tx) => tx.transactionAction.args.args_json,
    );

    return tokens.map((token) => {
      const { symbol } = token.metadata;

      const txData = preFilteredTransactions
        .filter(
          ({ transactionAction }) =>
            (transactionAction.args as any).method_name == 'create_token',
        )
        .find((tx) => {
          const { symbol: txSymbol } =
            (tx.transactionAction.args.args_json as any)?.args?.metadata || {};

          return symbol === txSymbol;
        });

      const enrichedToken = {
        ...token,
        transactionHash: txData?.transactionHash,
        createTimestamp: txData?.blockTimestamp,
      };

      return enrichedToken;
    });
  }

  private reduceTransactionsByAccountId(transactions: Transaction[]): {
    [key: string]: Transaction[];
  } {
    return transactions.reduce(
      (acc, cur) => ({
        ...acc,
        [cur.receiverAccountId]: [...(acc[cur.receiverAccountId] || []), cur],
      }),
      {},
    );
  }
}
