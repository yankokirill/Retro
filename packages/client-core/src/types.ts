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
  /**
   * Только у дельт, удалённых каскадом (ADR-0010: действие над сущностью,
   * созданной отклонённой дельтой, или отзыв отклонённого голоса), — dot
   * исходно отклонённой дельты; `reason` у них — её причина. У самой
   * отклонённой сервером дельты поля нет.
   */
  readonly cause?: Dot;
}

/** Снимок для экрана и для проверок симулятора — неизменяемые данные, не сам объект `SyncClient`. */
export interface ClientSnapshot {
  readonly actorId: string;
  /** X_c — подтверждённое состояние (`consistency-model.md` § 6). */
  readonly confirmed: State;
  /** P — дельты, отправленные (или ждущие отправки), но ещё не подтверждённые, в порядке добавления. */
  readonly pending: readonly PendingEntry[];
  /** X_c ⊔ ⨆P — состояние, из которого строится экран; считается по первому обращению и запоминается. */
  readonly full: State;
  /** materialize(X_c ⊔ ⨆P) — то, что «на экране». */
  readonly view: View;
  /** Максимум `seq`, когда-либо полученный этим клиентом (в `welcome` или `op`); `null` — ничего не получал. */
  readonly lastSeq: number | null;
  readonly status: ClientStatus;
  /** Из последнего `welcome`; `null` до первого подключения. */
  readonly role: Role | null;
  /** Из последнего `welcome`/`meta`; `null` до первого подключения. */
  readonly meta: BoardMeta | null;
  /**
   * Из `welcome`; `null` до самого первого `welcome`, полученного этим
   * экземпляром — блокирует `vote`/`unvote` (`not_welcomed_yet`). Дальше НЕ
   * сбрасывается ни `disconnected()`, ни `receive(error)` — иначе офлайн
   * `vote` (REQ-023 кр. 1, ровно этот пример есть в тексте требования) был
   * бы невозможен после первого же разрыва связи.
   */
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
   * строки, которые нужно отправить в ответ. Сообщение, не прошедшее
   * `serverMessageSchema` (`@retro/protocol`), — ошибка протокола, `receive`
   * бросает исключение, а не игнорирует его.
   *
   * По типу сообщения (непустой массив возвращают только `welcome` и `reject`):
   * - `welcome` — `status := "welcomed"`; `role`/`meta`/`voterToken` — из
   *   сообщения; `X_c := X_c ⊔ fromWire(snapshot?.state) ⊔ fromWire(ops[i].delta)`
   *   для всех `i`; `lastSeq := max(lastSeq, snapshot?.upToSeq, ops[i].seq)`.
   *   Возвращает по одному `op` на каждый элемент `P`, в порядке добавления
   *   (REQ-023 кр. 2) — `P` при этом не меняется, элементы остаются ждать
   *   свои `ack`/`reject`.
   * - `op` — `X_c := X_c ⊔ fromWire(delta)`, `lastSeq := max(lastSeq, seq)`.
   *   Безусловно, независимо от `status` (даже до `welcome` этого
   *   соединения) — никогда не отбрасывается. Возвращает `[]`.
   * - `ack {dot, seq}` — первый элемент `P` (в порядке добавления) с этим
   *   `dot`: переносится в `X_c` (`merge`), удаляется из `P`. Нет такого
   *   элемента (повтор, либо dot никогда не отправлялся этим клиентом) —
   *   игнор, `X_c`/`P` не меняются. Возвращает `[]`.
   * - `reject {dot, reason}` — первый элемент `P` с этим `dot` (`δ`)
   *   удаляется из `P` (в `X_c` не переносится), в конец `rejections`
   *   добавляется `{dot, reason}`. Нет такого элемента — игнор, `rejections`
   *   не растёт, возвращает `[]`. Иначе очередь закрывается от ссылок на `δ`
   *   (ADR-0010, `consistency-model.md` § 6):
   *   1. `R := {δ}`; каждый элемент `π` после `δ`, в порядке `P`, зависит от
   *      `R`, если (а) пишет в ячейку сущности, созданной дельтой из `R`,
   *      голосует за неё, отзывает голос за неё или ставит её id значением
   *      поля `group`; (б) — `unvote` голоса, поданного дельтой из `R`; (в)
   *      перекрывает (`supersedes`) запись, внесённую дельтой из `R`.
   *      Зависимый `π` добавляется в `R`.
   *   2. (а) или (б): `π` удаляется из `P`; в `rejections` —
   *      `{dot: π.dot, reason, cause: δ.dot}` (в порядке `P`).
   *   3. Только (в): `π` удаляется, его `intent` будет пересобран.
   *   4. Часы: `lamport := max lamport записей в X_c ⊔ ⨆P` (после удалений,
   *      до пересборки); счётчик dot не меняется.
   *   5. Пересобираемые намерения выполняются заново, как `act()` без
   *      проверок `queue_full`/`not_welcomed_yet`, над текущим `X_c ⊔ ⨆P`,
   *      в исходном порядке; результаты — в конец `P` со свежими dot.
   *   6. `outbox.save` — один раз, с итоговым `P`.
   *   Возвращает по одному `op` на каждую пересобранную дельту, если
   *   `status === "welcomed"`, иначе `[]` (уйдут со следующим `welcome`).
   * - `meta {meta}` — снимок `meta` заменяется целиком присланным. Возвращает `[]`.
   * - `commandResult` — наблюдаемого эффекта нет (нет поля в `ClientSnapshot`
   *   под результаты команд — T-028 не вводит реестр команда→результат, это
   *   дело UI/T-015). Не бросает. Возвращает `[]`.
   * - `error {reason}` — `status := "offline"` (сервер сам закроет
   *   соединение; `disconnected()` от адаптера, если последует, — идемпотентен).
   *   `X_c`, `P`, `rejections`, `voterToken` не меняются. Возвращает `[]`.
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
