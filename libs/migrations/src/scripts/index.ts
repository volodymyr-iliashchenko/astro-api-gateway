import { ProposalPurgeMigration } from './proposal-purge.migration';
import { ProposalActionsMigration } from './proposal-actions.migration';
import { TokenIdsMigration } from './token-ids.migration';
import { DaoMetadataMigration } from './dao-metadata.migration';
import { BountyClaimEndTimeMigration } from './bounty-claim-end-time';
import { ProposalVoteMigration } from './proposal-vote.migration';

export default [
  ProposalPurgeMigration,
  ProposalActionsMigration,
  TokenIdsMigration,
  DaoMetadataMigration,
  BountyClaimEndTimeMigration,
  ProposalVoteMigration,
];
