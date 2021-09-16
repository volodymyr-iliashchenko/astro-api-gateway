import { TransactionInfo } from 'src/common/dto/TransactionInfo';
import { BountyDto } from './bounty.dto';

export class BountyClaimDto extends TransactionInfo {
  bounty: BountyDto;
  accountId: string;
  /// Start time of the claim.
  startTime: string;
  /// Deadline specified by claimer.
  deadline: string;
  /// Completed?
  completed: boolean;
}
