/** Shared by the Attachments panel and any page that links to a file. */

export const DOC_KINDS: Record<string, string> = {
  gst_cert: 'GST certificate', pan: 'PAN card', cancelled_cheque: 'Cancelled cheque', msme_cert: 'Udyam certificate',
  agreement: 'Agreement', statement: 'Bank statement', proof: 'Proof', bill: 'Bill', other: 'Other document',
};

export const MAX_MB = 15;

export function fileUrl(id: string, download = false) {
  return `${import.meta.env.VITE_API_URL}/attachments/${id}/file${download ? '?download=1' : ''}`;
}
