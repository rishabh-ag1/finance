import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../api';
import { Button, Card, Chip, ErrorNote, Field, Modal, Select, TextInput } from '../../components/ui/kit';
import { useAuth } from '../../context/auth';
import { GST_STATE_LIST, stateLabel } from '../../lib/gstStates';
import { formatINR } from '../../lib/money';
import { apiErrorMessage } from '../../lib/utils';
import { useDeliveryAddresses, usePurchaseItems, type DeliveryAddress, type PurchaseItem } from '../purchases/api';

// F041 delivery addresses and F042 purchase catalogue, used on POs.
export function PurchasingTab() {
  const { data: addresses } = useDeliveryAddresses();
  const { data: items } = usePurchaseItems();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('financePurchases', 'edit');
  const [address, setAddress] = useState<DeliveryAddress | 'new' | null>(null);
  const [item, setItem] = useState<PurchaseItem | 'new' | null>(null);

  return (
    <div className="space-y-4">
      <Card className="p-4 sm:p-6 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-semibold text-gray-900">Delivery addresses</h2>
          {canEdit && <Button variant="secondary" onClick={() => setAddress('new')}>Add address</Button>}
        </div>
        <p className="text-sm text-gray-600">Where vendors deliver. The state is the place of supply on the PO, which decides CGST + SGST or IGST.</p>
        <ul className="divide-y divide-gray-100">
          {addresses?.map((a) => (
            <li key={a.id} className="py-2.5 flex items-start justify-between gap-2 text-sm">
              <span className={a.isActive ? '' : 'text-gray-400 line-through'}>
                <b>{a.label}</b> · {stateLabel(a.stateCode)}
                <span className="block text-gray-500 whitespace-pre-line">{a.address}</span>
              </span>
              {canEdit && <Button variant="ghost" onClick={() => setAddress(a)}>Edit</Button>}
            </li>
          ))}
        </ul>
      </Card>

      <Card className="p-4 sm:p-6 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-semibold text-gray-900">Purchase catalogue</h2>
          {canEdit && <Button variant="secondary" onClick={() => setItem('new')}>Add item</Button>}
        </div>
        <p className="text-sm text-gray-600">Things you buy often. Picking one on a PO fills HSN, unit, GST and the last rate paid.</p>
        {items?.length === 0 && <p className="text-sm text-gray-500">Nothing yet. Items can also be typed as free text on a PO.</p>}
        <ul className="divide-y divide-gray-100">
          {items?.map((i) => (
            <li key={i.id} className="py-2.5 flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0">
                <span className="block truncate">{i.name}</span>
                <span className="block text-xs text-gray-500">{[i.hsnSac && `HSN ${i.hsnSac}`, i.unit, i.defaultGstRate && `GST ${Number(i.defaultGstRate)}%`, i.lastRate && `last ${formatINR(i.lastRate)}`].filter(Boolean).join(' · ')}</span>
              </span>
              {canEdit && <Button variant="ghost" onClick={() => setItem(i)}>Edit</Button>}
            </li>
          ))}
        </ul>
      </Card>

      {address && <AddressForm address={address === 'new' ? null : address} onClose={() => setAddress(null)} />}
      {item && <ItemForm item={item === 'new' ? null : item} onClose={() => setItem(null)} />}
    </div>
  );
}

function AddressForm({ address, onClose }: { address: DeliveryAddress | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ label: address?.label ?? '', address: address?.address ?? '', stateCode: address?.stateCode ?? '', isActive: address?.isActive ?? true });
  const save = useMutation({
    mutationFn: async () => (address ? api.put(`/purchases/delivery-addresses/${address.id}`, f) : api.post('/purchases/delivery-addresses', f)),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['delivery-addresses'] }); onClose(); },
  });
  return (
    <Modal title={address ? 'Edit delivery address' : 'Add delivery address'} onClose={onClose} footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button disabled={save.isPending} onClick={() => save.mutate()}>Save</Button>
    </>}>
      <ErrorNote>{save.isError && apiErrorMessage(save.error, 'Could not save')}</ErrorNote>
      <Field label="Name"><TextInput value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="Ambala CM premises" /></Field>
      <Field label="Address"><textarea className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm" rows={3} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
      <Field label="State">
        <Select value={f.stateCode} onChange={(e) => setF({ ...f, stateCode: e.target.value })}>
          <option value="">Choose</option>
          {GST_STATE_LIST.map(([c, n]) => <option key={c} value={c}>{n} ({c})</option>)}
        </Select>
      </Field>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> In use</label>
    </Modal>
  );
}

function ItemForm({ item, onClose }: { item: PurchaseItem | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: item?.name ?? '', hsnSac: item?.hsnSac ?? '', unit: item?.unit ?? 'Nos', defaultGstRate: item?.defaultGstRate ? String(Number(item.defaultGstRate)) : '', isArchived: item?.isArchived ?? false });
  const save = useMutation({
    mutationFn: async () => (item ? api.put(`/purchases/items/${item.id}`, f) : api.post('/purchases/items', f)),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['purchase-items'] }); onClose(); },
  });
  return (
    <Modal title={item ? 'Edit item' : 'Add item'} onClose={onClose} footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button disabled={save.isPending} onClick={() => save.mutate()}>Save</Button>
    </>}>
      <ErrorNote>{save.isError && apiErrorMessage(save.error, 'Could not save')}</ErrorNote>
      <Field label="Name"><TextInput value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Aluminium extrusion die" /></Field>
      <div className="grid grid-cols-3 gap-2">
        <Field label="HSN/SAC"><TextInput value={f.hsnSac} onChange={(e) => setF({ ...f, hsnSac: e.target.value })} /></Field>
        <Field label="Unit"><TextInput value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} /></Field>
        <Field label="GST %"><TextInput inputMode="decimal" value={f.defaultGstRate} onChange={(e) => setF({ ...f, defaultGstRate: e.target.value })} /></Field>
      </div>
      {item && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.isArchived} onChange={(e) => setF({ ...f, isArchived: e.target.checked })} /> No longer bought (hide)</label>}
      {item && <Chip>Archived items stay on old POs</Chip>}
    </Modal>
  );
}
