import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { NEAR_INDEXER_DB_CONNECTION } from 'src/common/constants';
import { Repository } from 'typeorm';
import { Account, Transaction } from '.';
import { Receipt } from './entities/receipt.entity';

@Injectable()
export class NearService {
  constructor(
    @InjectRepository(Account, NEAR_INDEXER_DB_CONNECTION)
    private readonly accountRepository: Repository<Account>,

    @InjectRepository(Transaction, NEAR_INDEXER_DB_CONNECTION)
    private readonly transactionRepository: Repository<Transaction>,

    @InjectRepository(Receipt, NEAR_INDEXER_DB_CONNECTION)
    private readonly receiptRepository: Repository<Receipt>,
  ) {}

  /**
   * Using parent contract name to retrieve child information since
   * child accounts are built based on parent contract name domain
   * see: 
   *    genesis.sputnik-v2.testnet 
   * is built on top of 
   *    sputnik-v2.testnet account
   */
  async findAccountsByContractName(contractName: string): Promise<Account[]> {
    return this.accountRepository
      .createQueryBuilder('account')
      .leftJoinAndSelect('account.receipt', 'receipts')
      .where('account.account_id like :id', { id: `%${contractName}%` })
      .getMany();
  }

  async findTransactionsByReceiverAccountIds(
    receiverAccountIds: string[],
    fromBlockTimestamp?: number,
  ): Promise<Transaction[]> {
    let queryBuilder = this.transactionRepository
      .createQueryBuilder('transaction')
      .leftJoinAndSelect('transaction.transactionAction', 'transaction_actions')
      .where('transaction.receiver_account_id = ANY(ARRAY[:...ids])', {
        ids: receiverAccountIds,
      })
      .orderBy('transaction.block_timestamp', 'ASC');

    queryBuilder = fromBlockTimestamp
      ? queryBuilder.andWhere('transaction.block_timestamp > :from', {
          from: fromBlockTimestamp,
        })
      : queryBuilder;

    return queryBuilder.getMany();
  }

  async lastTransaction(receiverAccountIds: string[]): Promise<Transaction> {
    return this.transactionRepository
      .createQueryBuilder('transaction')
      .leftJoinAndSelect('transaction.transactionAction', 'transaction_actions')
      .where('transaction.receiver_account_id = ANY(ARRAY[:...ids])', {
        ids: receiverAccountIds,
      })
      .orderBy('transaction.block_timestamp', 'DESC')
      .getOne();
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
}
