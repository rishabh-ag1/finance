import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../api';
import { Button, Card, Chip, ErrorNote, Field, Modal, PageHeader, Select, TextInput } from '../components/ui/kit';
import { useAuth } from '../context/auth';
import { apiErrorMessage } from '../lib/utils';

type Perms = Record<string, { view?: boolean; edit?: boolean }>;
type Role = { id: string; name: string; description: string | null; permissions: Perms; isActive: boolean; users: number };
type User = { id: string; email: string; firstName: string; lastName: string; roleId: string | null; roleName: string | null; isActive: boolean; lastLoginAt: string | null; locked: boolean };

function RoleForm({ role, modules, onClose }: { role: Role | null; modules: { key: string; label: string }[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [perms, setPerms] = useState<Perms>(role?.permissions ?? {});
  const set = (k: string, level: 'none' | 'view' | 'edit') => setPerms({ ...perms, [k]: level === 'edit' ? { view: true, edit: true } : level === 'view' ? { view: true } : {} });
  const save = useMutation({
    mutationFn: async () => (role ? api.put(`/roles/${role.id}`, { name, description, permissions: perms, isActive: true }) : api.post('/roles', { name, description, permissions: perms })),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['roles'] }); onClose(); },
  });
  return (
    <Modal title={role ? `Role ${role.name}` : 'New role'} onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button disabled={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Name"><TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="CA_VIEWER" /></Field>
        <Field label="Description"><TextInput value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      </div>
      <ul className="mt-3 divide-y divide-gray-100 text-sm max-h-80 overflow-y-auto">
        {modules.map((m) => {
          const p = perms[m.key] ?? {};
          return (
            <li key={m.key} className="py-1.5 flex items-center justify-between gap-2">
              <span className="truncate">{m.label}</span>
              <Select className="w-28" value={p.edit ? 'edit' : p.view ? 'view' : 'none'} onChange={(e) => set(m.key, e.target.value as 'none')}><option value="none">No access</option><option value="view">View</option><option value="edit">Edit</option></Select>
            </li>
          );
        })}
      </ul>
      <ErrorNote>{save.isError && apiErrorMessage(save.error, 'Not saved')}</ErrorNote>
    </Modal>
  );
}

function UserForm({ roles, onClose }: { roles: Role[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ email: '', firstName: '', lastName: '', roleId: '', password: '' });
  const save = useMutation({ mutationFn: async () => api.post('/users', f), onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); onClose(); } });
  return (
    <Modal title="Add user" onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button disabled={save.isPending} onClick={() => save.mutate()}>Add</Button></>}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="First name"><TextInput value={f.firstName} onChange={(e) => setF({ ...f, firstName: e.target.value })} /></Field>
        <Field label="Last name"><TextInput value={f.lastName} onChange={(e) => setF({ ...f, lastName: e.target.value })} /></Field>
        <Field label="E-mail" className="sm:col-span-2"><TextInput type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Role"><Select value={f.roleId} onChange={(e) => setF({ ...f, roleId: e.target.value })}><option value="">Choose…</option>{roles.filter((r) => r.isActive).map((r) => <option key={r.id} value={r.id}>{r.name.replace(/_/g, ' ')}</option>)}</Select></Field>
        <Field label="First password" hint="At least 10 characters; they change it after signing in"><TextInput type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
      </div>
      <ErrorNote>{save.isError && apiErrorMessage(save.error, 'Not added')}</ErrorNote>
    </Modal>
  );
}

// F171 users and roles.
export function UsersPage() {
  const qc = useQueryClient();
  const { user: me, hasPermission } = useAuth();
  const canEdit = hasPermission('financeUsers', 'edit');
  const [roleForm, setRoleForm] = useState<Role | 'new' | null>(null);
  const [adding, setAdding] = useState(false);
  const { data: users } = useQuery({ queryKey: ['users'], queryFn: async () => (await api.get<{ data: User[] }>('/users')).data.data });
  const { data: r } = useQuery({ queryKey: ['roles'], queryFn: async () => (await api.get<{ data: { roles: Role[]; modules: { key: string; label: string }[] } }>('/roles')).data.data });
  const update = useMutation({ mutationFn: async (v: { id: string; body: object }) => api.put(`/users/${v.id}`, v.body), onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); qc.invalidateQueries({ queryKey: ['roles'] }); } });
  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <PageHeader title="Users and roles" subtitle="Who can sign in and what each role may see or change. Users are switched off, never deleted." action={canEdit && <Button onClick={() => setAdding(true)}>Add user</Button>} />
      <ErrorNote>{update.isError && apiErrorMessage(update.error, 'Not changed')}</ErrorNote>
      <Card className="divide-y divide-gray-100">
        {users?.map((u) => (
          <div key={u.id} className="px-3 sm:px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="font-medium text-gray-900 truncate">{u.firstName} {u.lastName} {u.id === me?.id && <span className="text-xs text-gray-500">(you)</span>}</div>
              <div className="text-xs text-gray-500 truncate">{u.email}{u.lastLoginAt ? ` · last signed in ${new Date(u.lastLoginAt).toLocaleDateString('en-IN')}` : ' · never signed in'}</div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {!u.isActive && <Chip tone="gray">Off</Chip>}
              {u.locked && <Chip tone="red">Locked</Chip>}
              {canEdit && u.id !== me?.id ? (
                <>
                  <Select value={u.roleId ?? ''} disabled={update.isPending} onChange={(e) => update.mutate({ id: u.id, body: { roleId: e.target.value } })}>{r?.roles.filter((x) => x.isActive).map((x) => <option key={x.id} value={x.id}>{x.name.replace(/_/g, ' ')}</option>)}</Select>
                  <Button variant="ghost" disabled={update.isPending} onClick={() => update.mutate({ id: u.id, body: { isActive: !u.isActive } })}>{u.isActive ? 'Switch off' : 'Switch on'}</Button>
                </>
              ) : <Chip tone="blue">{u.roleName?.replace(/_/g, ' ') ?? 'No role'}</Chip>}
            </div>
          </div>
        ))}
      </Card>
      <Card className="p-4 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold text-gray-900">Roles</h2>
          {canEdit && <Button variant="secondary" onClick={() => setRoleForm('new')}>New role</Button>}
        </div>
        <ul className="divide-y divide-gray-100 text-sm">
          {r?.roles.map((x) => (
            <li key={x.id} className="py-2 flex items-center justify-between gap-2">
              <div className="min-w-0"><div className="font-medium">{x.name.replace(/_/g, ' ')}</div><div className="text-xs text-gray-500 truncate">{x.description ?? ''} · {x.users} user(s) · {Object.values(x.permissions).filter((p) => p.edit).length} edit, {Object.values(x.permissions).filter((p) => p.view && !p.edit).length} view-only modules</div></div>
              {canEdit && <Button variant="ghost" onClick={() => setRoleForm(x)}>Change</Button>}
            </li>
          ))}
        </ul>
      </Card>
      {roleForm && r && <RoleForm role={roleForm === 'new' ? null : roleForm} modules={r.modules} onClose={() => setRoleForm(null)} />}
      {adding && r && <UserForm roles={r.roles} onClose={() => setAdding(false)} />}
    </div>
  );
}
