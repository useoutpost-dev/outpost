export type OutpostErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'TIMEOUT'
  | 'PROVIDER_ERROR'
  | 'UPSTREAM_ERROR'
  | 'INTERNAL';

export class OutpostError extends Error {
  readonly code: OutpostErrorCode;
  readonly httpStatus: number;
  readonly safeMessage: string;

  constructor(
    code: OutpostErrorCode,
    httpStatus: number,
    safeMessage: string,
    options?: { cause?: unknown },
  ) {
    super(safeMessage, options);
    this.name = 'OutpostError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.safeMessage = safeMessage;
  }

  toJSON(): { error: { code: OutpostErrorCode; message: string } } {
    return { error: { code: this.code, message: this.safeMessage } };
  }

  static is(err: unknown): err is OutpostError {
    return err instanceof OutpostError;
  }
}
