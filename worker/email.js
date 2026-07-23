// Outbound email — first (and so far only) use is password-reset links. Resend's plain REST API,
// no SDK: one fetch, no extra dependency. Failures are logged and swallowed by the caller so the
// /api/forgot-password response never reveals whether sending succeeded (see index.js).

export async function sendPasswordResetEmail(env, { to, resetUrl }) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    console.error("RESEND_API_KEY is not configured — skipping password reset email send.");
    return false;
  }
  const from = env.RESET_EMAIL_FROM || "Paratransit Companion <onboarding@resend.dev>";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [to],
        subject: "Reset your Paratransit Companion password",
        html: `<p>Someone requested a password reset for this account.</p>
<p><a href="${resetUrl}">${resetUrl}</a></p>
<p>This link expires in 1 hour and can only be used once. If you didn't request this, you can ignore this email.</p>`,
      }),
    });
    if (!res.ok) console.error("Resend send failed", res.status, await res.text().catch(() => ""));
    return res.ok;
  } catch (e) {
    console.error("Resend send threw", e);
    return false;
  }
}
