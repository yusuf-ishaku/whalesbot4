import { Api, InlineKeyboard } from "grammy";

export interface BotGroupStatus {
  ok: boolean;
  title?: string;
  reason?: string;
}

/** All Telegram side effects go through this so enforcement can be tested with a fake. */
export interface TelegramGateway {
  readonly configured: boolean;
  sendMessage(chatId: number | string, text: string): Promise<void>;
  createInviteLink(groupId: string, opts: { expiresMinutes: number; joinRequest: boolean; name: string }): Promise<string>;
  revokeInviteLink(groupId: string, link: string): Promise<void>;
  /** Kick: ban then (unless permanent) unban so the person can rejoin later. */
  removeMember(groupId: string, userId: number, opts: { permanent: boolean }): Promise<void>;
  approveJoinRequest(groupId: string, userId: number): Promise<void>;
  declineJoinRequest(groupId: string, userId: number): Promise<void>;
  isChatAdmin(groupId: string, userId: number): Promise<boolean>;
  botUsername(): Promise<string>;
  /** Mute (true) or restore the group's default permissions (false). */
  restrictMember(groupId: string, userId: number, mute: boolean): Promise<void>;
  /** Post a message in the group, optionally with one URL button. Returns the message id. */
  postNotice(groupId: string, text: string, button?: { text: string; url: string }): Promise<number>;
  deleteMessage(groupId: string, messageId: number): Promise<void>;
  /** Checks the bot is an admin with invite + restrict rights in the group. */
  botStatus(groupId: string): Promise<BotGroupStatus>;
}

export class GrammyGateway implements TelegramGateway {
  readonly configured = true;
  private botId?: number;
  constructor(private api: Api) {}

  async sendMessage(chatId: number | string, text: string) {
    await this.api.sendMessage(chatId, text, { link_preview_options: { is_disabled: true } });
  }
  async createInviteLink(groupId: string, o: { expiresMinutes: number; joinRequest: boolean; name: string }) {
    const expire_date = Math.floor(Date.now() / 1000) + o.expiresMinutes * 60;
    const link = await this.api.createChatInviteLink(groupId, {
      name: o.name.slice(0, 32),
      expire_date,
      ...(o.joinRequest ? { creates_join_request: true } : { member_limit: 1 }),
    });
    return link.invite_link;
  }
  async revokeInviteLink(groupId: string, link: string) {
    await this.api.revokeChatInviteLink(groupId, link);
  }
  async removeMember(groupId: string, userId: number, o: { permanent: boolean }) {
    await this.api.banChatMember(groupId, userId, { revoke_messages: false });
    if (!o.permanent) await this.api.unbanChatMember(groupId, userId, { only_if_banned: true });
  }
  async approveJoinRequest(groupId: string, userId: number) {
    await this.api.approveChatJoinRequest(groupId, userId);
  }
  async declineJoinRequest(groupId: string, userId: number) {
    await this.api.declineChatJoinRequest(groupId, userId);
  }
  async isChatAdmin(groupId: string, userId: number) {
    const m = await this.api.getChatMember(groupId, userId);
    return m.status === "creator" || m.status === "administrator";
  }
  async botUsername() {
    return (await this.api.getMe()).username ?? "";
  }
  async restrictMember(groupId: string, userId: number, mute: boolean) {
    if (mute) {
      await this.api.restrictChatMember(groupId, userId, {
        can_send_messages: false, can_send_audios: false, can_send_documents: false, can_send_photos: false,
        can_send_videos: false, can_send_video_notes: false, can_send_voice_notes: false, can_send_polls: false,
        can_send_other_messages: false, can_add_web_page_previews: false, can_invite_users: false,
        can_change_info: false, can_pin_messages: false,
      });
      return;
    }
    const chat = await this.api.getChat(groupId);
    const defaults = ("permissions" in chat && chat.permissions) || { can_send_messages: true };
    await this.api.restrictChatMember(groupId, userId, { ...defaults, can_send_messages: true });
  }
  async postNotice(groupId: string, text: string, button?: { text: string; url: string }) {
    const m = await this.api.sendMessage(groupId, text, {
      link_preview_options: { is_disabled: true },
      ...(button ? { reply_markup: new InlineKeyboard().url(button.text, button.url) } : {}),
    });
    return m.message_id;
  }
  async deleteMessage(groupId: string, messageId: number) {
    await this.api.deleteMessage(groupId, messageId);
  }
  async botStatus(groupId: string): Promise<BotGroupStatus> {
    try {
      this.botId ??= (await this.api.getMe()).id;
      const [chat, me] = await Promise.all([this.api.getChat(groupId), this.api.getChatMember(groupId, this.botId)]);
      const title = "title" in chat ? chat.title : undefined;
      if (me.status !== "administrator") return { ok: false, title, reason: "Bot is not an admin of this group." };
      if (!me.can_invite_users) return { ok: false, title, reason: "Bot lacks the 'invite users' right." };
      if (!me.can_restrict_members) return { ok: false, title, reason: "Bot lacks the 'ban users' right." };
      return { ok: true, title };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }
}

/** Used until TELEGRAM_BOT_TOKEN is configured. Every call fails loudly, so nothing is silently skipped. */
export class NullGateway implements TelegramGateway {
  readonly configured = false;
  private fail(): never {
    throw new Error("Telegram is not configured (TELEGRAM_BOT_TOKEN missing)");
  }
  sendMessage(): Promise<void> { return this.fail(); }
  createInviteLink(): Promise<string> { return this.fail(); }
  revokeInviteLink(): Promise<void> { return this.fail(); }
  removeMember(): Promise<void> { return this.fail(); }
  approveJoinRequest(): Promise<void> { return this.fail(); }
  declineJoinRequest(): Promise<void> { return this.fail(); }
  isChatAdmin(): Promise<boolean> { return this.fail(); }
  botUsername(): Promise<string> { return this.fail(); }
  restrictMember(): Promise<void> { return this.fail(); }
  postNotice(): Promise<number> { return this.fail(); }
  deleteMessage(): Promise<void> { return this.fail(); }
  async botStatus(): Promise<BotGroupStatus> { return { ok: false, reason: "TELEGRAM_BOT_TOKEN is not set." }; }
}
