/** Shapes of the /api/bank responses (money is text). */

export type BalanceCheck = {
  status: 'ok' | 'gap' | 'mismatch';
  fileOpening: string;
  fileClosing: string;
  expectedOpening: string | null;
  notes: string[];
  missingFrom: string | null;
  missingTo: string | null;
};

export type PreviewRow = {
  seq: number; txnDate: string; valueDate: string | null; narration: string; chequeNo: string | null;
  debit: string; credit: string; balance: string; parsed: boolean; mode: string | null; modeDetail: string | null;
  utr: string | null; counterpartyName: string | null; counterpartyIfsc: string | null; counterpartyAccount: string | null;
  remark: string | null; isDuplicate: boolean; monthLocked: boolean;
};

export type Preview = {
  account: { id: string; bankName: string; accountNumberMasked: string };
  periodFrom: string; periodTo: string; rowsTotal: number; rowsNew: number; rowsDuplicate: number;
  rowsUnparsed: number; rowsInLockedMonths: number; totalDebit: string; totalCredit: string;
  newDebit: string; newCredit: string; balanceCheck: BalanceCheck; rows: PreviewRow[];
};

export type Batch = {
  id: string; bankAccountId: string; bankName?: string; fileName: string; periodFrom: string; periodTo: string;
  rowsTotal: number; rowsNew: number; rowsDuplicate: number; openingBalance: string; closingBalance: string;
  totalDebit: string; totalCredit: string; balanceCheckStatus: 'ok' | 'gap' | 'mismatch'; balanceCheckNotes: string[];
  missingFrom: string | null; missingTo: string | null; importedBy: string; importedByName?: string; importedAt: string;
};

export type BankTxn = {
  id: string; txnDate: string; narrationRaw: string; debit: string; credit: string; balance: string | null;
  parseOk: boolean; mode: string | null; modeDetail: string | null; utr: string | null; counterpartyName: string | null;
  counterpartyIfsc: string | null; counterpartyAccount: string | null; remark: string | null; status: string;
  categorisationReason: string | null;
};
