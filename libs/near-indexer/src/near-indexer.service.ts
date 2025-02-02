import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectRepository } from '@nestjs/typeorm';
import PromisePool from '@supercharge/promise-pool';
import { NEAR_INDEXER_DB_CONNECTION } from '@sputnik-v2/common';
import {
  NFTTokenActionDto,
  NFTTokenUpdateDto,
  TokenUpdateDto,
} from '@sputnik-v2/token';
import { Connection, Repository, SelectQueryBuilder } from 'typeorm';
import {
  Account,
  Transaction,
  AccountChange,
  ActionReceiptAction,
  Receipt,
} from './entities';
import { getBlockTimestamp } from '@sputnik-v2/utils';

@Injectable()
export class NearIndexerService {
  constructor(
    private readonly configService: ConfigService,

    @InjectRepository(Account, NEAR_INDEXER_DB_CONNECTION)
    private readonly accountRepository: Repository<Account>,

    @InjectRepository(Transaction, NEAR_INDEXER_DB_CONNECTION)
    private readonly transactionRepository: Repository<Transaction>,

    @InjectRepository(Receipt, NEAR_INDEXER_DB_CONNECTION)
    private readonly receiptRepository: Repository<Receipt>,

    @InjectRepository(ActionReceiptAction, NEAR_INDEXER_DB_CONNECTION)
    private readonly actionReceiptActionRepository: Repository<ActionReceiptAction>,

    @InjectRepository(AccountChange, NEAR_INDEXER_DB_CONNECTION)
    private readonly accountChangeRepository: Repository<AccountChange>,

    @InjectConnection(NEAR_INDEXER_DB_CONNECTION)
    private connection: Connection,
  ) {}

  firstTransaction(): Promise<Transaction> {
    return this.transactionRepository.findOne({
      order: { blockTimestamp: 'ASC' },
    });
  }

  lastTransaction(): Promise<Transaction> {
    return this.transactionRepository.findOne({
      order: { blockTimestamp: 'DESC' },
    });
  }

  /**
   * Using parent contract name to retrieve child information since
   * child accounts are built based on parent contract name domain
   * see:
   *    genesis.sputnikv2.testnet
   * is built on top of
   *    sputnikv2.testnet account
   */
  async findAccountsByContractName(contractName: string): Promise<Account[]> {
    return this.accountRepository
      .createQueryBuilder('account')
      .leftJoinAndSelect('account.receipt', 'receipts')
      .leftJoinAndSelect('receipts.originatedFromTransaction', 'transactions')
      .where('account.account_id like :id', { id: `%${contractName}%` })
      .getMany();
  }

  async findAccountsByAccountIds(accountIds: string[]): Promise<Account[]> {
    return this.accountRepository
      .createQueryBuilder('account')
      .leftJoinAndSelect('account.receipt', 'receipts')
      .leftJoinAndSelect('receipts.originatedFromTransaction', 'transactions')
      .where('account.account_id = ANY(ARRAY[:...ids])', { ids: accountIds })
      .getMany();
  }

  async findLastAccountChangesByContractName(
    contractName: string,
    fromBlockTimestamp?: number,
  ): Promise<AccountChange> {
    return this.buildAccountChangeQuery(
      contractName,
      fromBlockTimestamp,
    ).getOne();
  }

  async findAccountChangesByContractName(
    contractName: string,
    fromBlockTimestamp?: number,
  ): Promise<AccountChange[]> {
    return this.buildAccountChangeQuery(
      contractName,
      fromBlockTimestamp,
    ).getMany();
  }

  /** Pass either single accountId or array of accountIds */
  async findLastTransactionByAccountIds(
    accountIds: string | string[],
    fromBlockTimestamp?: number,
  ): Promise<Transaction> {
    return this.buildAggregationTransactionQuery(accountIds, fromBlockTimestamp)
      .select('transaction.transactionHash')
      .orderBy('transaction.block_timestamp', 'DESC')
      .getOne();
  }

  /** Pass either single accountId or array of accountIds */
  async findTransactionsByAccountIds(
    accountIds: string | string[],
    fromBlockTimestamp?: number,
    toBlockTimestamp?: number,
  ): Promise<Transaction[]> {
    return this.buildAggregationTransactionQuery(
      accountIds,
      fromBlockTimestamp,
      toBlockTimestamp,
    )
      .orderBy('transaction.block_timestamp', 'ASC')
      .getMany();
  }

  async findNFTActionReceiptsByReceiverAccountIds(
    receiverAccountIds: string[],
    fromBlockTimestamp?: number,
  ): Promise<ActionReceiptAction[]> {
    const { results: actionReceipts, errors } =
      await PromisePool.withConcurrency(5)
        .for(receiverAccountIds)
        .process(async (id) => {
          let queryBuilder = this.actionReceiptActionRepository
            .createQueryBuilder('action_receipt_action')
            .leftJoinAndSelect(
              'action_receipt_action.transaction',
              'transactions',
            )
            .where(
              "action_receipt_action.args->'args_json'->>'receiver_id' = :id and action_kind = 'FUNCTION_CALL' and action_receipt_action.args->>'args_json' is not null and args->>'method_name' like 'nft_%'",
              {
                id,
              },
            );

          queryBuilder = fromBlockTimestamp
            ? queryBuilder.andWhere('transaction.block_timestamp >= :from', {
                from: fromBlockTimestamp,
              })
            : queryBuilder;

          return await queryBuilder.getMany();
        });

    return actionReceipts.reduce((acc, prop) => acc.concat(prop), []);
  }

  async findTransaction(transactionHash: string): Promise<Transaction> {
    return this.transactionRepository.findOne(transactionHash);
  }

  async findReceiptByTransactionHashAndPredecessor(
    transactionHash: string,
    predecessorAccountId: string,
  ): Promise<Receipt> {
    //TODO: Revise a possibility of multiple receipts with the query below
    return this.receiptRepository
      .createQueryBuilder('receipt')
      .leftJoinAndSelect('receipt.originatedFromTransaction', 'transactions')
      .where('receipt.originated_from_transaction_hash = :transactionHash', {
        transactionHash,
      })
      .andWhere('receipt.predecessor_account_id like :id', {
        id: `%${predecessorAccountId}%`,
      })
      .getOne();
  }

  async findAccountByReceiptId(receiptId: string): Promise<Account> {
    return this.accountRepository
      .createQueryBuilder('account')
      .where('account.created_by_receipt_id = :receiptId', { receiptId })
      .getOne();
  }

  async findReceiptsByReceiverAccountIds(
    receiverAccountIds: string[],
    fromBlockTimestamp?: number,
  ): Promise<Receipt[]> {
    let queryBuilder = this.receiptRepository
      .createQueryBuilder('receipt')
      .leftJoinAndSelect('receipt.receiptActions', 'action_receipt_actions')
      .where('receipt.receiver_account_id = ANY(ARRAY[:...ids])', {
        ids: receiverAccountIds,
      });

    queryBuilder = fromBlockTimestamp
      ? queryBuilder.andWhere('receipt.included_in_block_timestamp >= :from', {
          from: fromBlockTimestamp,
        })
      : queryBuilder;

    return queryBuilder.getMany();
  }

  async findAccountChangeActionsByContractName(
    contractName: string,
    fromBlockTimestamp?: number,
  ): Promise<AccountChange[]> {
    return this.buildAccountChangeActionQuery(
      contractName,
      fromBlockTimestamp,
    ).getMany();
  }

  // Account Likely Tokens - taken from NEAR Helper Indexer middleware
  // https://github.com/near/near-contract-helper/blob/master/middleware/indexer.js
  async findLikelyTokens(accountId: string): Promise<string[]> {
    const { bridgeTokenFactoryContractName } = this.configService.get('near');

    const received = `
        select distinct receipt_receiver_account_id as receiver_account_id
        from action_receipt_actions
        where args->'args_json'->>'receiver_id' = $1
            and action_kind = 'FUNCTION_CALL'
            and args->>'args_json' is not null
            and args->>'method_name' in ('ft_transfer', 'ft_transfer_call','ft_mint')
    `;

    const mintedWithBridge = `
        select distinct receipt_receiver_account_id as receiver_account_id from (
            select args->'args_json'->>'account_id' as account_id, receipt_receiver_account_id
            from action_receipt_actions
            where action_kind = 'FUNCTION_CALL' and
                receipt_predecessor_account_id = $2 and
                args->>'method_name' = 'mint'
        ) minted_with_bridge
        where account_id = $1
    `;

    const calledByUser = `
        select distinct receipt_receiver_account_id as receiver_account_id
        from action_receipt_actions
        where receipt_predecessor_account_id = $1
            and action_kind = 'FUNCTION_CALL'
            and (args->>'method_name' like 'ft_%' or args->>'method_name' = 'storage_deposit')
    `;

    const [receivedTokens, mintedWithBridgeTokens, calledByUserTokens] =
      await Promise.all([
        this.connection.query(received, [accountId]),
        this.connection.query(mintedWithBridge, [
          accountId,
          bridgeTokenFactoryContractName,
        ]),
        this.connection.query(calledByUser, [accountId]),
      ]);

    return [
      ...new Set(
        [
          ...receivedTokens,
          ...mintedWithBridgeTokens,
          ...calledByUserTokens,
        ].map(({ receiver_account_id }) => receiver_account_id),
      ),
    ];
  }

  async findLikelyTokenUpdates(
    accountId: string,
    fromBlockTimestamp: number,
  ): Promise<TokenUpdateDto[]> {
    const { bridgeTokenFactoryContractName } = this.configService.get('near');

    const received = `
        select distinct receipt_receiver_account_id as token, args->'args_json'->>'receiver_id' as account, receipt_included_in_block_timestamp as timestamp
        from action_receipt_actions
        where args->'args_json'->>'receiver_id' like $1
            and action_kind = 'FUNCTION_CALL'
            and args->>'args_json' is not null
            and args->>'method_name' in ('ft_transfer', 'ft_transfer_call','ft_mint')
            and receipt_included_in_block_timestamp  > $2
    `;

    const mintedWithBridge = `
        select distinct receipt_receiver_account_id as token, account_id as account, receipt_included_in_block_timestamp as timestamp from (
            select args->'args_json'->>'account_id' as account_id, receipt_receiver_account_id, receipt_included_in_block_timestamp
            from action_receipt_actions
            where action_kind = 'FUNCTION_CALL' and
                receipt_predecessor_account_id = $2 and
                args->>'method_name' = 'mint'
            and receipt_included_in_block_timestamp > $3
        ) minted_with_bridge
        where account_id like $1
    `;

    const calledByUser = `
        select distinct receipt_receiver_account_id as token, receipt_predecessor_account_id as account, receipt_included_in_block_timestamp as timestamp
        from action_receipt_actions
        where receipt_predecessor_account_id like $1
            and action_kind = 'FUNCTION_CALL'
            and (args->>'method_name' like 'ft_%' or args->>'method_name' = 'storage_deposit')
        and receipt_included_in_block_timestamp  > $2
    `;

    const [receivedTokens, mintedWithBridgeTokens, calledByUserTokens] =
      await Promise.all([
        this.connection.query(received, [accountId, fromBlockTimestamp]),
        this.connection.query(mintedWithBridge, [
          accountId,
          bridgeTokenFactoryContractName,
          fromBlockTimestamp,
        ]),
        this.connection.query(calledByUser, [accountId, fromBlockTimestamp]),
      ]);

    return [
      ...receivedTokens,
      ...mintedWithBridgeTokens,
      ...calledByUserTokens,
    ];
  }

  // Account Likely NFTs - taken from NEAR Helper Indexer middleware
  // https://github.com/near/near-contract-helper/blob/master/middleware/indexer.js
  async findLikelyNFTs(accountId: string): Promise<string[]> {
    const received = `
        select distinct receipt_receiver_account_id as receiver_account_id
        from action_receipt_actions
        where args->'args_json'->>'receiver_id' = $1
            and action_kind = 'FUNCTION_CALL'
            and args->>'args_json' is not null
            and args->>'method_name' like 'nft_%'
    `;

    const receivedTokens = await this.connection.query(received, [accountId]);

    return receivedTokens.map(({ receiver_account_id }) => receiver_account_id);
  }

  async findLikelyNFTsUpdates(
    accountId: string,
    fromBlockTimestamp: number,
  ): Promise<NFTTokenUpdateDto[]> {
    const received = `
        select distinct receipt_receiver_account_id as nft, args->'args_json'->>'receiver_id' as account, receipt_included_in_block_timestamp as timestamp
        from action_receipt_actions
        where args->'args_json'->>'receiver_id' like $1
            and action_kind = 'FUNCTION_CALL'
            and args->>'args_json' is not null
            and args->>'method_name' like 'nft_%'
        and receipt_included_in_block_timestamp  > $2
    `;

    return this.connection.query(received, [accountId, fromBlockTimestamp]);
  }

  async findContractsNFTsActions(
    contractNames: string[],
    fromBlockTimestamp: number,
  ): Promise<NFTTokenActionDto[]> {
    const received = `
        select distinct receipt_receiver_account_id as nft, args->'args_json' as args, receipt_included_in_block_timestamp as timestamp
        from action_receipt_actions
        where receipt_receiver_account_id like any (array[$1])
            and action_kind = 'FUNCTION_CALL'
            and args->>'args_json' is not null
            and args->>'method_name' like 'nft_%'
        and receipt_included_in_block_timestamp  > $2
    `;

    return this.connection.query(received, [
      contractNames.join(','),
      fromBlockTimestamp,
    ]);
  }

  async receiptsByAccount(accountId: string): Promise<Receipt[]> {
    return this.receiptRepository
      .createQueryBuilder('receipt')
      .leftJoinAndSelect('receipt.receiptActions', 'action_receipt_actions')
      .where(
        'receipt.receiver_account_id = :accountId OR receipt.predecessor_account_id = :accountId',
        {
          accountId,
        },
      )
      .orderBy('included_in_block_timestamp', 'ASC')
      .getMany();
  }

  async receiptsByAccountToken(
    accountId: string,
    tokenId: string,
  ): Promise<Receipt[]> {
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);
    oneDayAgo.setHours(0, 0, 0, 0);

    const actions = await this.actionReceiptActionRepository
      .createQueryBuilder('action_receipt_actions')
      .select('action_receipt_actions.receiptId')
      .where(
        `receipt_included_in_block_timestamp > :blockTimestamp AND (receipt_receiver_account_id = :tokenId AND (args->'args_json'->>'receiver_id' = :accountId OR receipt_predecessor_account_id = :accountId))`,
        {
          tokenId,
          accountId,
          blockTimestamp: getBlockTimestamp(oneDayAgo),
        },
      )
      .getMany();

    return actions.length > 0
      ? await this.receiptRepository
          .createQueryBuilder('receipt')
          .leftJoinAndSelect('receipt.receiptActions', 'action_receipt_actions')
          .where('receipt.receipt_id = ANY(ARRAY[:...ids])', {
            ids: actions.map(({ receiptId }) => receiptId),
          })
          .orderBy('included_in_block_timestamp', 'ASC')
          .getMany()
      : [];
  }

  private buildAggregationTransactionQuery(
    accountIds: string | string[],
    fromBlockTimestamp?: number,
    toBlockTimestamp?: number,
  ): SelectQueryBuilder<Transaction> {
    let queryBuilder = this.transactionRepository
      .createQueryBuilder('transaction')
      .leftJoinAndSelect(
        'transaction.transactionAction',
        'transaction_actions',
      );
    // .leftJoinAndSelect(
    //   'transaction.receipts',
    //   'receipts',
    //   'receipts.predecessor_account_id = ANY(ARRAY[:...ids])',
    //   { ids: receiverAccountIds },
    // )
    // .leftJoinAndSelect(
    //   'receipts.receiptActions',
    //   'action_receipt_actions',
    //   'action_receipt_actions.receipt_predecessor_account_id = ANY(ARRAY[:...ids]) AND action_receipt_actions.action_kind = :actionKind',
    //   { ids: receiverAccountIds, actionKind: ActionKind.Transfer },
    // )

    queryBuilder =
      accountIds instanceof Array
        ? queryBuilder.where(
            'transaction.receiver_account_id = ANY(ARRAY[:...ids])',
            {
              ids: accountIds,
            },
          )
        : queryBuilder.where('transaction.receiver_account_id LIKE :id', {
            id: `%${accountIds}`,
          });

    queryBuilder = fromBlockTimestamp
      ? queryBuilder.andWhere('transaction.block_timestamp >= :from', {
          from: fromBlockTimestamp,
        })
      : queryBuilder;

    queryBuilder = toBlockTimestamp
      ? queryBuilder.andWhere('transaction.block_timestamp <= :to', {
          to: toBlockTimestamp,
        })
      : queryBuilder;

    return queryBuilder;
  }

  private buildAccountChangeQuery(
    contractName: string,
    fromBlockTimestamp?: number,
  ): SelectQueryBuilder<AccountChange> {
    let queryBuilder = this.accountChangeRepository
      .createQueryBuilder('account_change')
      .orderBy('account_change.changed_in_block_timestamp', 'DESC')
      .where('account_change.affected_account_id like :id', {
        id: `%${contractName}%`,
      });

    queryBuilder = fromBlockTimestamp
      ? queryBuilder.andWhere(
          'account_change.changed_in_block_timestamp >= :from',
          {
            from: fromBlockTimestamp,
          },
        )
      : queryBuilder;

    return queryBuilder;
  }

  private buildAccountChangeActionQuery(
    contractName: string,
    fromBlockTimestamp?: number,
  ): SelectQueryBuilder<AccountChange> {
    return this.accountChangeRepository
      .createQueryBuilder('account_change')
      .leftJoinAndSelect('account_change.causedByReceipt', 'receipts')
      .leftJoinAndSelect('receipts.originatedFromTransaction', 'transactions')
      .leftJoinAndSelect(
        'transactions.transactionAction',
        'transaction_actions',
      )
      .where('account_change.affected_account_id like :id', {
        id: `%${contractName}%`,
      })
      .andWhere('account_change.changed_in_block_timestamp > :from', {
        from: fromBlockTimestamp,
      })
      .orderBy('transactions.block_timestamp', 'ASC');
  }
}
