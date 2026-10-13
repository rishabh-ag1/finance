import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Paperclip, Upload } from 'lucide-react';
import api from '../api';
import { useAuth } from '../context/auth';
import { formatDateTime } from '../lib/format';
import { apiErrorMessage } from '../lib/utils';
import { Button, ErrorNote, Field, Modal, Select, TextInput } from './ui/kit';
import { DOC_KINDS, fileUrl, MAX_MB } from '../lib/attachments';

export type AttachmentRow = {
  id: string; docKind: string; docKindLabel: string; fileName: string; originalName: string; mimeType: string;
  sizeBytes: number; storage: string; folderPath: string; note: string | null; uploadedBy: string; uploadedAt: string;
};

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

const size = (bytes: number) => (bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/**
 * F160 files on a record: list, open, attach, remove (archive with a reason). The parent passes
 * the document kinds that make sense for the record; the first is the default.
 */
export function Attachments({ recordType, recordId, kinds, onChange, compact }: {
  recordType: string;
  recordId: string;
  kinds: string[];
  onChange?: () => void;
  compact?: boolean;
}) {
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('financeDocuments', 'edit');
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState<AttachmentRow | null>(null);
  const key = ['attachments', recordType, recordId];
  const { data: files } = useQuery({
    queryKey: key,
    queryFn: async () => (await api.get<{ data: AttachmentRow[] }>('/attachments', { params: { recordType, recordId } })).data.data,
  });
  const changed = () => { qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: ['missing-docs'] }); onChange?.(); };

  return (
    <div className="space-y-2">
      {files && files.length === 0 && !compact && <p className="text-sm text-gray-500">No files attached.</p>}
      <ul className="divide-y divide-gray-100 text-sm">
        {files?.map((f) => (
          <li key={f.id} className="py-2 flex items-center justify-between gap-2">
            <a href={fileUrl(f.id)} target="_blank" rel="noreferrer" className="min-w-0 flex items-center gap-2 text-blue-700 hover:underline">
              <FileText className="w-4 h-4 shrink-0" />
              <span className="min-w-0">
                <span className="block truncate">{f.fileName}</span>
                <span className="block text-xs text-gray-500">{f.docKindLabel} · {size(f.sizeBytes)} · {f.uploadedBy}, {formatDateTime(f.uploadedAt)}</span>
              </span>
            </a>
            {canEdit && <Button variant="ghost" onClick={() => setRemoving(f)}>Remove</Button>}
          </li>
        ))}
      </ul>
      {canEdit && (
        <Button variant="secondary" onClick={() => setUploading(true)}>
          <Paperclip className="w-4 h-4 inline mr-1" />Attach file
        </Button>
      )}
      {uploading && <UploadForm recordType={recordType} recordId={recordId} kinds={kinds} onClose={() => setUploading(false)} onDone={changed} />}
      {removing && <RemoveForm file={removing} onClose={() => setRemoving(null)} onDone={changed} />}
    </div>
  );
}

function UploadForm({ recordType, recordId, kinds, onClose, onDone }: { recordType: string; recordId: string; kinds: string[]; onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [docKind, setDocKind] = useState(kinds[0] ?? 'other');
  const [note, setNote] = useState('');
  const save = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('Choose a file');
      if (file.size > MAX_MB * 1024 * 1024) throw new Error(`The file is over ${MAX_MB} MB`);
      return api.post('/attachments', { recordType, recordId, docKind, fileName: file.name, contentBase64: await readAsBase64(file), note });
    },
    onSuccess: () => { onDone(); onClose(); },
  });
  return (
    <Modal title="Attach a file" onClose={onClose} footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button disabled={!file || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Uploading…' : 'Attach'}</Button>
    </>}>
      <ErrorNote>{save.isError && apiErrorMessage(save.error, 'Could not attach the file')}</ErrorNote>
      <Field label="What is it?">
        <Select value={docKind} onChange={(e) => setDocKind(e.target.value)}>
          {kinds.map((k) => <option key={k} value={k}>{DOC_KINDS[k] ?? k}</option>)}
        </Select>
      </Field>
      <label className="flex items-center justify-center gap-2 px-4 py-6 rounded-lg border border-dashed border-gray-300 text-sm text-gray-700 cursor-pointer hover:bg-gray-50">
        <Upload className="w-4 h-4" />
        <span className="truncate">{file ? file.name : 'Choose a PDF, photo, Excel or Word file (up to 15 MB)'}</span>
        <input type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.csv,.xlsx,.xls,.docx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      <p className="text-xs text-gray-500">The file is renamed and filed automatically; on a phone you can take a photo.</p>
      <Field label="Note (optional)"><TextInput value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </Modal>
  );
}

function RemoveForm({ file, onClose, onDone }: { file: AttachmentRow; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const remove = useMutation({
    mutationFn: async () => api.post(`/attachments/${file.id}/archive`, { reason }),
    onSuccess: () => { onDone(); onClose(); },
  });
  return (
    <Modal title="Remove file" onClose={onClose} footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button variant="danger" disabled={reason.trim().length < 3 || remove.isPending} onClick={() => remove.mutate()}>Remove</Button>
    </>}>
      <ErrorNote>{remove.isError && apiErrorMessage(remove.error, 'Could not remove')}</ErrorNote>
      <p className="text-sm text-gray-600">{file.fileName} will be hidden from this record. The file itself is kept and the removal is in the audit log.</p>
      <Field label="Why?"><TextInput autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </Modal>
  );
}
