import { ApiHideProperty, ApiProperty } from '@nestjs/swagger';
import { Exclude } from 'class-transformer';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn
} from 'typeorm';

@Entity()
export class Dao {

  @ApiProperty()
  @PrimaryColumn({ type: 'text', unique: true })
  id: string;

  @ApiProperty()
  @Column()
  amount: string;

  @ApiProperty()
  @Column()
  bond: string;

  @ApiProperty()
  @Column()
  purpose: string;

  @ApiProperty()
  @Column()
  votePeriod: string;

  @ApiProperty()
  @Column("text", { array: true, nullable: true })
  council: string[];

  @ApiProperty()
  @Column()
  numberOfProposals: number;

  @ApiProperty()
  @Column({ nullable: true })
  councilSeats: number;

  @ApiProperty()
  @Column({ nullable: true })
  numberOfMembers: number;

  @ApiProperty()
  @Column({ nullable: true })
  txHash: string;

  @ApiHideProperty()
  @Exclude()
  @CreateDateColumn({
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  createdAt: Date;

  @ApiHideProperty()
  @Exclude()
  @UpdateDateColumn({
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  updatedAt: Date;
}
