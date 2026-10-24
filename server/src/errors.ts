// Business errors returned to the agent as {ok:false, error:{code,message}} (spec 04).

export type ErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'INACTIVE'
  | 'INSUFFICIENT_STOCK'
  | 'OFFER_INVALID'
  | 'OFFER_EXPIRED'
  | 'ZONE_REQUIRED'
  | 'ADDRESS_REQUIRED'
  | 'UNKNOWN_ZONE'
  | 'AMOUNT_MISMATCH'
  | 'INVALID_STATE'
  | 'INTERNAL';

export class BusinessError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
