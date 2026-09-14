// T-009 — анонимный токен голосующего (protocol.md § 2, REQ-015 кр. 5).
import { createHmac } from "node:crypto";

/**
 * `voterToken = HMAC(secret, boardId + guestId)` — стабилен для одного
 * гостя на одной доске между переподключениями (клиент считает свои голоса
 * по нему), но по нему нельзя восстановить `guestId` без секрета сервера.
 * Секрет — из `VOTER_TOKEN_SECRET` (`.env.example`), не хранится в CRDT.
 */
export function computeVoterToken(secret: string, boardId: string, guestId: string): string {
  return createHmac("sha256", secret).update(`${boardId}:${guestId}`).digest("base64url");
}
