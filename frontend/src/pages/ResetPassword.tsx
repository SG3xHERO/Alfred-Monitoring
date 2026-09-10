import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { post } from "../api";
import { Button, inputCls } from "../components/bits";

export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (password !== confirm) {
      setError("passwords don't match");
      return;
    }
    try {
      await post("/api/auth/reset-password", { token, password });
      setDone(true);
      setTimeout(() => navigate("/login"), 1500);
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center">
      <form onSubmit={submit} className="w-80 border border-line bg-panel p-6">
        <div className="mb-5 text-center font-semibold tracking-[0.18em] text-[14px]">ALFRED</div>
        {!token ? (
          <div className="text-[13px] text-crit">Missing reset token — use the link from your email.</div>
        ) : done ? (
          <div className="text-[13px] text-ok">Password updated — redirecting to sign in…</div>
        ) : (
          <>
            <label className="mb-1 block text-[12px] text-ink-2">New password</label>
            <input className={inputCls} type="password" value={password} autoFocus
              placeholder="At least 8 characters" onChange={(e) => setPassword(e.target.value)} />
            <label className="mb-1 mt-3 block text-[12px] text-ink-2">Confirm password</label>
            <input className={inputCls} type="password" value={confirm}
              onChange={(e) => setConfirm(e.target.value)} />
            {error && <div className="mt-3 text-[12px] text-crit">{error}</div>}
            <Button kind="primary" className="mt-4 w-full" type="submit"
              disabled={password.length < 8 || confirm.length < 8}>
              Reset password
            </Button>
          </>
        )}
        <div className="mt-3 text-center">
          <Link to="/login" className="text-[12px] text-ink-3 hover:text-ink">Back to sign in</Link>
        </div>
      </form>
    </div>
  );
}
