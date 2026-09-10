import { useCallback, useEffect, useState } from "react";
import { get, post, patch, del } from "../api";
import { ts } from "../format";
import { Panel, Button, inputCls } from "../components/bits";
import { useMe } from "../useMe";

interface User {
  id: number;
  username: string;
  email: string | null;
  role: "admin" | "operator" | "viewer";
  created_at: string;
  auth_provider: "local" | "microsoft";
  display_name: string | null;
  last_login_at: string | null;
}

export default function Users() {
  const me = useMe();
  if (me && me.role !== "admin") {
    return <div className="text-[13px] text-ink-3">Users are admin-only.</div>;
  }
  return (
    <div>
      <h1 className="mb-4 text-[15px] font-semibold">Users</h1>
      <UsersPanel />
    </div>
  );
}

function UsersPanel() {
  const [users, setUsers] = useState<User[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [resetting, setResetting] = useState<User | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    get<User[]>("/api/users").then(setUsers).catch(() => {});
    get<{ username: string }>("/api/auth/me").then((r) => setMe(r.username)).catch(() => {});
  }, []);
  useEffect(load, [load]);

  const remove = async (u: User) => {
    setError("");
    if (!confirm(`Delete user '${u.username}'?`)) return;
    try {
      await del(`/api/users/${u.id}`);
      load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const setRole = async (u: User, role: User["role"]) => {
    setError("");
    try {
      await patch(`/api/users/${u.id}/role`, { role });
      load();
    } catch (err: any) {
      setError(err.message);
      load();
    }
  };

  return (
    <Panel title="Users" right={<Button onClick={() => setShowAdd(true)}>Add user</Button>}>
      {error && <div className="border-b border-line bg-crit-bg px-3 py-2 text-[12px] text-crit">{error}</div>}
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-ink-3">
            <th className="px-3 py-1.5">Username</th>
            <th className="py-1.5 pr-3">Email</th>
            <th className="py-1.5 pr-3">Role</th>
            <th className="py-1.5 pr-3">Sign-in</th>
            <th className="py-1.5 pr-3">Last sign-in</th>
            <th className="py-1.5 pr-3">Created</th>
            <th className="py-1.5 pr-3"></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className="border-b border-line last:border-b-0">
              <td className="px-3 py-2 font-medium">
                {u.display_name || u.username}
                {u.username === me && <span className="ml-2 text-[11px] text-ink-3">(you)</span>}
              </td>
              <td className="py-2 pr-3">
                <EmailCell user={u} onSaved={load} />
              </td>
              <td className="py-2 pr-3">
                <select
                  className="border border-line-2 bg-panel px-1 py-0.5 text-[12px] disabled:opacity-50"
                  value={u.role}
                  disabled={u.username === me}
                  title={u.username === me ? "You cannot change your own role" : "operator: everything admin gets except users/Settings · viewer: sees everything, edits nothing"}
                  onChange={(e) => setRole(u, e.target.value as User["role"])}
                >
                  <option value="admin">admin</option>
                  <option value="operator">operator</option>
                  <option value="viewer">viewer</option>
                </select>
              </td>
              <td className="py-2 pr-3">
                <span className={`rounded-control px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide ${u.auth_provider === "microsoft" ? "bg-accent-soft text-accent" : "bg-paper text-ink-2"}`}>
                  {u.auth_provider === "microsoft" ? "Microsoft" : "local"}
                </span>
              </td>
              <td className="py-2 pr-3 text-ink-2">{u.last_login_at ? ts(u.last_login_at) : <span className="text-ink-3 italic">never</span>}</td>
              <td className="py-2 pr-3 text-ink-2">{ts(u.created_at)}</td>
              <td className="py-2 pr-3 text-right">
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {u.auth_provider !== "microsoft" && (
                    <button
                      className="border border-line-2 px-2 py-0.5 text-[11px] text-ink-2 hover:bg-paper hover:text-ink"
                      title={`Reset ${u.username}'s password`}
                      onClick={() => setResetting(u)}
                    >
                      Reset password
                    </button>
                  )}
                  <button
                    title={u.username === me ? "You cannot delete your own account" : `Delete ${u.username}`}
                    disabled={u.username === me}
                    className="px-1 text-ink-3 hover:text-crit disabled:cursor-not-allowed disabled:opacity-30"
                    onClick={() => remove(u)}
                  >
                    ✕
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {showAdd && (
        <AddUserModal
          onClose={() => setShowAdd(false)}
          onCreated={() => { setShowAdd(false); load(); }}
        />
      )}
      {resetting && (
        <ResetPasswordModal user={resetting} onClose={() => setResetting(null)} />
      )}
    </Panel>
  );
}

function ResetPasswordModal({ user, onClose }: { user: User; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  const save = async () => {
    setError("");
    setSaving(true);
    try {
      await patch(`/api/users/${user.id}/password`, { password });
      setDone(true);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-10 flex items-start justify-center bg-black/30 pt-24" onClick={onClose}>
      <div className="w-[420px] border border-line bg-panel p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-1 text-[14px] font-semibold">Reset password</h2>
        <p className="mb-4 text-[12px] text-ink-3">
          Sets a new password for <span className="font-medium text-ink">{user.username}</span> immediately —
          they aren't notified, so you'll need to pass it on yourself.
        </p>
        {done ? (
          <>
            <div className="mb-4 border border-line bg-paper p-2 font-mono text-[12px]">{password}</div>
            <div className="flex justify-end">
              <Button onClick={onClose}>Done</Button>
            </div>
          </>
        ) : (
          <>
            <label className="mb-1 block text-[12px] text-ink-2">New password</label>
            <input className={inputCls} type="text" value={password} autoFocus
              placeholder="At least 8 characters" onChange={(e) => setPassword(e.target.value)} />
            {error && <div className="mt-3 text-[12px] text-crit">{error}</div>}
            <div className="mt-4 flex justify-end gap-2">
              <Button onClick={onClose}>Cancel</Button>
              <Button kind="primary" disabled={password.length < 8 || saving} onClick={save}>
                {saving ? "Saving…" : "Set password"}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function EmailCell({ user, onSaved }: { user: User; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(user.email || "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await patch(`/api/users/${user.id}`, { email: value });
      setEditing(false);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <button
        className="text-left text-ink-2 hover:text-ink"
        title="Click to edit — needed for self-serve password reset"
        onClick={() => { setValue(user.email || ""); setEditing(true); }}
      >
        {user.email || <span className="text-ink-3 italic">not set</span>}
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1">
      <input
        className="w-40 border border-line-2 bg-panel px-1.5 py-0.5 text-[12px]"
        value={value} autoFocus type="email"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
      />
      <button className="text-[11px] text-ok disabled:opacity-50" disabled={saving} onClick={save}>✓</button>
      <button className="text-[11px] text-ink-3" onClick={() => setEditing(false)}>✕</button>
    </div>
  );
}

function AddUserModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<User["role"]>("admin");
  const [error, setError] = useState("");

  const create = async () => {
    setError("");
    try {
      await post("/api/users", { username, email, password, role });
      onCreated();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="fixed inset-0 z-10 flex items-start justify-center bg-black/30 pt-24" onClick={onClose}>
      <div className="w-[420px] border border-line bg-panel p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-4 text-[14px] font-semibold">Add user</h2>
        <label className="mb-1 block text-[12px] text-ink-2">Username</label>
        <input className={inputCls} value={username} autoFocus onChange={(e) => setUsername(e.target.value)} />
        <label className="mb-1 mt-3 block text-[12px] text-ink-2">Email (optional — needed for password reset)</label>
        <input className={inputCls} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <label className="mb-1 mt-3 block text-[12px] text-ink-2">Password</label>
        <input className={inputCls} type="password" value={password}
          placeholder="At least 8 characters" onChange={(e) => setPassword(e.target.value)} />
        <label className="mb-1 mt-3 block text-[12px] text-ink-2">Role</label>
        <select className={inputCls} value={role} onChange={(e) => setRole(e.target.value as User["role"])}>
          <option value="admin">admin — full access, including users/Settings</option>
          <option value="operator">operator — everything admin gets except users/Settings</option>
          <option value="viewer">viewer — sees everything, edits nothing</option>
        </select>
        {error && <div className="mt-3 text-[12px] text-crit">{error}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button kind="primary" disabled={!username.trim() || password.length < 8} onClick={create}>
            Create user
          </Button>
        </div>
      </div>
    </div>
  );
}
