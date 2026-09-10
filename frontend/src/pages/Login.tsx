import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { get, post } from "../api";
import { Button, inputCls } from "../components/bits";
import { microsoftSignInAvailable, signInWithMicrosoft } from "../msal";

function MicrosoftLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 21 21" className="shrink-0">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [msAvailable, setMsAvailable] = useState(false);
  const [msBusy, setMsBusy] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    get<{ needed: boolean }>("/api/setup/status")
      .then((s) => { if (s.needed) navigate("/setup"); })
      .catch(() => {});
    microsoftSignInAvailable()
      .then(setMsAvailable)
      .catch(() => setMsAvailable(false));
  }, [navigate]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await post("/api/auth/login", { username, password });
      navigate("/");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const submitMicrosoft = async () => {
    setError("");
    setMsBusy(true);
    try {
      await signInWithMicrosoft();
      navigate("/");
    } catch (err: any) {
      if (err?.errorCode !== "user_cancelled" && err?.name !== "BrowserAuthError") {
        setError(err.message || "Microsoft sign-in failed");
      }
    } finally {
      setMsBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-paper p-6">
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: "radial-gradient(circle at 38% 42%, var(--color-accent-soft), transparent 62%)" }}
      />
      <div className="relative flex flex-col items-center gap-8 sm:flex-row sm:gap-14">
        <img src="/logo-full.png" alt="Alfred" className="w-52 sm:w-60" />

        <form
          onSubmit={submit}
          className="w-80 rounded-panel border border-line-2 bg-panel/70 p-8 shadow-panel backdrop-blur-sm"
        >
          <div className="mb-1 text-[15px] font-semibold text-ink">Welcome back</div>
          <div className="mb-6 text-[12px] text-ink-3">Sign in to continue</div>

          <label className="mb-1 block text-[12px] text-ink-2">Username</label>
          <input className={inputCls} value={username} autoFocus autoComplete="username"
            onChange={(e) => setUsername(e.target.value)} />
          <label className="mb-1 mt-3 block text-[12px] text-ink-2">Password</label>
          <input className={inputCls} type="password" value={password} autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)} />

          {error && <div className="mt-3 text-[12px] text-crit">{error}</div>}

          <Button kind="primary" className="mt-5 w-full" type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>

          <div className="mt-3 text-center">
            <Link to="/forgot-password" className="text-[12px] text-ink-3 hover:text-ink">
              Forgot password?
            </Link>
          </div>

          {msAvailable && (
            <>
              <div className="my-5 flex items-center gap-3 text-[11px] uppercase tracking-wider text-ink-3">
                <span className="h-px flex-1 bg-line" />
                or
                <span className="h-px flex-1 bg-line" />
              </div>
              <button
                type="button"
                onClick={submitMicrosoft}
                disabled={msBusy}
                className="flex h-10 w-full items-center justify-center gap-3 rounded-control border border-line-2 bg-white px-4 text-[13px] font-medium text-[#1b1b1b] shadow-sm transition hover:border-line disabled:pointer-events-none disabled:opacity-60"
              >
                <MicrosoftLogo />
                <span>{msBusy ? "Opening sign-in…" : "Sign in with Microsoft"}</span>
              </button>
            </>
          )}
        </form>
      </div>
    </div>
  );
}
