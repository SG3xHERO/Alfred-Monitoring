import { useState } from "react";
import { Link } from "react-router-dom";
import { post } from "../api";
import { Button, inputCls } from "../components/bits";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await post("/api/auth/forgot-password", { email });
      setSent(true);
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center">
      <form onSubmit={submit} className="w-80 border border-line bg-panel p-6">
        <div className="mb-5 text-center font-semibold tracking-[0.18em] text-[14px]">ALFRED</div>
        {sent ? (
          <div className="text-[13px] text-ink-2">
            If that email is on file, we've sent a link to reset your password. It expires in 1 hour.
          </div>
        ) : (
          <>
            <label className="mb-1 block text-[12px] text-ink-2">Email</label>
            <input className={inputCls} type="email" value={email} autoFocus
              onChange={(e) => setEmail(e.target.value)} />
            {error && <div className="mt-3 text-[12px] text-crit">{error}</div>}
            <Button kind="primary" className="mt-4 w-full" type="submit">Send reset link</Button>
          </>
        )}
        <div className="mt-3 text-center">
          <Link to="/login" className="text-[12px] text-ink-3 hover:text-ink">Back to sign in</Link>
        </div>
      </form>
    </div>
  );
}
