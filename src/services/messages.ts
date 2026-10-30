import type { RuntimeConfig } from "../config/runtime.js";

/** Default copy. Every key can be overridden in branding.messages from the dashboard. */
export const DEFAULT_MESSAGES: Record<string, string> = {
  "start.welcome": "Welcome to {community}! Verify your wallet to get access to our holder groups.",
  "captcha.prompt": "Quick check before we start: what is {a} + {b}?",
  "captcha.failed": "That's not right. Send /start to try again.",
  "captcha.passed": "Thanks!",
  "verify.link":
    "Open this link to prove you own your wallet (you'll sign a message; no tokens move and no gas is spent). It expires in {minutes} minutes and works once:\n{url}",
  "verify.done_eligible": "✅ Wallet verified. You qualify for {tier}. Combined holdings: {total}.",
  "verify.done_short":
    "Wallet verified, but your combined holdings ({total}) are below the minimum for {next}. You need {shortfall} more.",
  "verify.done_read_failed": "Wallet verified, but we couldn't read your balance right now. Send /reverify in a few minutes.",
  "verify.done_banned": "This account can't be verified.",
  "invite.link": "Your invite to {tier}:\n{url}\nIt's for you only and expires in {minutes} minutes.",
  "status.unverified": "You haven't verified a wallet yet. Send /start.",
  "status.eligible": "You qualify for {tier}. Combined holdings: {total}.",
  "status.next": "{shortfall} more to reach {next}.",
  "status.short":
    "Your combined holdings ({total}) are below the minimum for {next}. You need {shortfall} more.",
  "status.read_failed": "We couldn't read your balance right now. Please try again shortly.",
  "status.banned": "This account is not eligible.",
  "warn.grace_started":
    "⚠️ Your holdings ({total}) no longer meet {tier}. You have {hours}h to top up before you're removed. Send /reverify afterwards.",
  "warn.grace_reminder": "⏰ Reminder: about {hours}h left to restore your holdings for {tier}. Send /reverify when done.",
  "grace.cancelled": "✅ You qualify again, so your removal has been cancelled.",
  "removed": "You've been removed from {tier} because your holdings fell below the requirement ({threshold}). Top up and send /reverify to rejoin.",
  "banned": "You've been removed and can't rejoin.",
  "join.request_verify":
    "Hi! To join {tier} you need to verify your wallet holdings first. Open this link (expires in {minutes} minutes, no gas, no tokens move):\n{url}\nYour join request stays pending and is approved automatically once you qualify.",
  "join.approved": "✅ You're in! Your request to join {tier} was approved.",
  "join.declined_short":
    "Your join request for {tier} was declined: your combined holdings ({total}) are below the minimum ({threshold}). Top up and request again.",
  "join.declined_other": "Your join request for {tier} was declined. You qualify for {other}; check your invite for that group.",
  "join.declined_banned": "Your join request was declined.",
  "join.expired": "Your join request for {tier} expired before your wallet was verified. Send /start to verify, then request again.",
  "quarantine.notice":
    "👋 {name}, this group is for verified holders. You're muted for now: tap below to verify your wallet and you'll be let in automatically. If you don't verify within {hours}h you'll be removed.",
  "quarantine.button": "Verify my wallet",
  "link.ok": "Linked this group to {tier}.",
  "link.bad_code": "That link code is invalid or expired.",
  "link.not_admin": "Only a group admin can link this group.",
  "help": "Commands:\n/start – verify your wallet\n/status – see your tier and balance\n/reverify – re-check now\n/wallet – link a different wallet",
  "web.title": "Verify your wallet",
  "web.intro": "Connect your wallet and sign a message to prove you own it. No tokens are moved and no gas is spent.",
  "web.connect": "Connect wallet",
  "web.sign": "Sign message",
  "web.no_wallet": "No wallet detected in this browser. Open this page inside your wallet app's browser:",
  "web.expired": "This link has expired or was already used. Go back to the bot and send /start for a new one.",
  "web.success": "Done! You can return to Telegram.",
  "web.wallet_in_use": "That wallet is already linked to another Telegram account.",
  "web.bad_signature": "That signature didn't verify. Please try again.",
};

export function render(config: RuntimeConfig, key: string, vars: Record<string, string | number> = {}): string {
  const template = config.branding.messages[key] ?? DEFAULT_MESSAGES[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}
