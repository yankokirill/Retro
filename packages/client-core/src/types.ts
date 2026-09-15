// Публичный контракт ядра клиента — docs/design/T-005-simulator.md § 4,
// docs/spec/consistency-model.md § 6 («Клиент u»), REQ-023, REQ-024.
//
// Пакет чистый (CLAUDE.md, правило 7): без браузера, без I/O, без часов и
// без случайности — actorId, id команд и хранилище очереди приходят через
// `ClientCorePorts`, а не берутся сами.

import type { Color, Column, Dot, EntityId, Place, State, View } from "@retro/crdt";
import type { BoardMeta, Command, RejectReason, Role } from "@retro/protocol";
import type { OutboxStore, PendingEntry } from "./outbox.js";

/** Действие пользователя — то, что могла бы вызвать кнопка интерфейса или генератор симулятора. */
export type Intent =
  | {
      readonly type: "createSticker";
      readonly column: Column;
      readonly frac: string;
      readonly text: string;
      readonly color: Color;
    }
  | { readonly type: "editText"; readonly id: EntityId; readonly text: string }
  | { readonly type: "setColor"; readonly id: EntityId; readonly color: Color }
  | { readonly type: "move"; readonly id: EntityId; readonly place: Place }
  | { readonly type: "setGroup"; readonly id: EntityId; readonly group: EntityId | null }
  | { readonly type: "delete"; readonly id: EntityId }
  | { readonly type: "restore"; readonly id: EntityId }
  | {
      readonly type: "createGroup";
      readonly column: Column;
      readonly frac: string;
      readonly title: string;
    }
  | { readonly type: "renameGroup"; readonly id: EntityId; readonly title: string }
  | { readonly type: "createAction"; readonly text: string }
  /** То же поле `text`, что у стикера (§ 1.4 `consistency-model.md`, «все варианты») — на CRDT-уровне неотличимо от `editText`. */
  | { readonly type: "editAction"; readonly id: EntityId; readonly text: string }
  | { readonly type: "assign"; readonly id: EntityId; readonly guestId: string | null }
  | { readonly type: "setDone"; readonly id: EntityId; readonly done: boolean }
  | { readonly type: "vote"; readonly target: EntityId }
  | { readonly type: "unvote"; readonly voteDot: Dot; readonly target: EntityId };

export interface SyncClientConfig {
  readonly boardId: string;
  readonly guestId: string;
  readonly displayName: string;
  /**
   * ВС-3 (`docs/spec/simulator.md` § 13): локальный предел `|P|`, ниже
   * серверного `MAX_LAMPORT_AHEAD` (`apps/server/src/ops/validate.ts`), —
   * чтобы клиент отказывал новым действиям сам, а не бесконечно копил
   * дельты, которые сервер потом всё равно отклонит по V5. По умолчанию 500.
   */
  readonly maxPending?: number;
}

export interface ClientCorePorts {
  /**
   * Новый `actorId` (UUID) — вызывается РОВНО ОДИН РАЗ, при `createSyncClient`
   * (один экземпляр `SyncClient` = одна загрузка страницы, `consistency-model.md`
   * § 1.1). Переподключения внутри жизни этого экземпляра переиспользуют тот
   * же `actorId`; новый `actorId` появляется только у НОВОГО экземпляра
   * (в браузере — настоящая перезагрузка вкладки, T-014/ADR по ВС-1).
   */
  readonly newActorId: () => string;
  /** Новый `id` для каждого сообщения `command`. */
  readonly newCommandId: () => string;
  /** Персистентность очереди P — см. `outbox.ts`, ВС-1. */
  readonly outbox: OutboxStore;
}

export type ActFailureReason = "queue_full" | "not_welcomed_yet" | "invalid_intent";

export type ActResult =
  | { readonly ok: true; readonly send: readonly string[] }
  | { readonly ok: false; readonly reason: ActFailureReason };

export type ClientStatus = "offline" | "connecting" | "welcomed";

export interface Rejection {
  readonly dot: Dot;
  readonly reason: RejectReason;
}

/** Снимок для экрана и для проверок симулятора — неизменяемые данные, не сам объект `SyncClient`. */
export interface ClientSnapshot {
  readonly actorId: string;
  /** X_c — подтверждённое состояние (`consistency-model.md` § 6). */
  readonly confirmed: State;
  /** P — дельты, отправленные (или ждущие отправки), но ещё не подтверждённые, в порядке добавления. */
  readonly pending: readonly PendingEntry[];
  /** materialize(X_c ⊔ ⨆P) — то, что «на экране». */
  readonly view: View;
  /** Максимум `seq`, когда-либо полученный этим клиентом (в `welcome` или `op`); `null` — ничего не получал. */
  readonly lastSeq: number | null;
  readonly status: ClientStatus;
  /** Из последнего `welcome`; `null` до первого подключения. */
  readonly role: Role | null;
  /** Из последнего `welcome`/`meta`; `null` до первого подключения. */
  readonly meta: BoardMeta | null;
  /** Из `welcome`; `null` до первого подключения — блокирует `vote`/`unvote` (`not_welcomed_yet`). */
  readonly voterToken: string | null;
  /** Причины отказа своих операций, в порядке получения `reject` (REQ-024 кр. 2). Не усекается. */
  readonly rejections: readonly Rejection[];
}

/**
 * Ядро клиента: состояние одной вкладки + методы работы с доской. Никакого
 * транспорта — вызывающий (браузерный адаптер T-014 или симулятор T-005)
 * сам открывает/закрывает соединение и решает, когда вызвать `connected`/
 * `disconnected`/`receive`; `SyncClient` только говорит, что в ответ
 * отправить.
 */
export interface SyncClient {
  /**
   * Транспорт открыт. Если клиент уже не `"offline"` — идемпотентный
   * no-op, `[]` (защита от двойного `connect`). Иначе: `status := "connecting"`,
   * возвращает `[hello]` с этим же `actorId` (см. `ClientCorePorts.newActorId`)
   * и текущим `lastSeq`.
   */
  connected(): string[];

  /**
   * Строка от сервера (одно сообщение `ServerMessage`, protocol.md § 5) →
   * строки, которые нужно отправить в ответ. Порядок обработки по типам —
   * см. `docs/design/T-005-simulator.md` § 4, таблица «Сообщение / Действие».
   * Сообщение, не прошедшее `serverMessageSchema` (`@retro/protocol`), —
   * ошибка протокола, `receive` бросает исключение, а не игнорирует его.
   */
  receive(raw: string): string[];

  /**
   * Транспорт закрыт. `status := "offline"`. `X_c` и `P` не меняются —
   * оптимистичные правки остаются на экране (REQ-023 кр. 1), очередь
   * отправится заново после следующего `welcome`.
   */
  disconnected(): void;

  /**
   * Локальное действие пользователя. Применяется оптимистично и немедленно,
   * независимо от того, подключён ли клиент сейчас (REQ-023 кр. 1) — кроме
   * `vote`/`unvote` до самого первого `welcome` (нет ещё `voterToken`,
   * которым голос должен быть подписан, `protocol.md` § 2) — тогда
   * `{ok:false, reason:"not_welcomed_yet"}`.
   *
   * Порядок проверок (первая же подошедшая — причина отказа):
   * 1. `pending.length >= maxPending` → `queue_full`.
   * 2. `intent.type` — `vote`/`unvote`, а `voterToken` ещё `null` → `not_welcomed_yet`.
   * 3. Дельта строится конструктором `@retro/crdt` над `X_c ⊔ ⨆P` (операция
   *    видит собственные неподтверждённые правки, `consistency-model.md` § 3)
   *    и проверяется `clientDeltaSchema` (`@retro/protocol`) — построена, но
   *    не прошла схему (например, пустой/слишком длинный текст, некорректный
   *    `frac`) → `invalid_intent`.
   *
   * При `ok:false` — состояние не меняется вообще: ни `P`, ни `X_c`, ни
   * внутренние часы, ни `outbox`. Существование и видимость цели (`id`
   * из `Intent`) НЕ проверяется — это дело того, кто формирует `Intent`
   * (интерфейс показывает только видимые сущности; генератор симулятора —
   * аналогично, `docs/spec/simulator.md` § 5.2); сервер отклонит
   * ссылку на несуществующую сущность через V3 обычным `reject` (REQ-024).
   *
   * При `ok:true` — дельта добавлена в конец `P`, часы обновлены (кроме
   * `unvote` — он их не тратит, § 3.1 `consistency-model.md`), `outbox.save`
   * вызван с новым `P`. `send` — `[op]`, если `status === "welcomed"`,
   * иначе `[]` (дельта всё равно в очереди, будет отправлена при следующем
   * `welcome`, REQ-023 кр. 1–2).
   */
  act(intent: Intent): ActResult;

  /**
   * Команда над метаданными доски (§ 3.2 `consistency-model.md`) — не CRDT,
   * в `P` не попадает и оффлайн не копится (в отличие от `act`, для команд
   * такого требования нет ни в одном REQ). Возвращает `[command]`, если
   * `status === "welcomed"`, иначе `[]` — команда просто не отправляется.
   */
  command(command: Command): string[];

  /** Снимок текущего состояния — новый объект, безопасно сохранять между вызовами. */
  inspect(): ClientSnapshot;
}
