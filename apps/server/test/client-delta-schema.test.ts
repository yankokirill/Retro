// fix/T-011-op-single-entity — находка независимого /code-review (high):
// `clientDeltaSchema` (`packages/protocol/src/wire.ts`) сейчас проверяет
// только «один dot» (`operationDots(delta).size === 1`), но НЕ проверяет
// «одна сущность» — записи двух разных сущностей, несущие один и тот же
// (в т.ч. подделанный) dot, сейчас проходят схему как «одна операция».
//
// docs/spec/consistency-model.md § 7 V2 (только что уточнено под эту
// находку): «δ — ровно одна операция из §3.1 (все записи и, если есть,
// создание — одной и той же сущности; каждая операция в §3.1 по построению
// пишет ровно в одну)».
// docs/spec/protocol.md § 5, reason `invalid_shape`: «не одна операция, не
// одна сущность (записи/создание на разные `entity`), значение вне домена,
// лимиты § 1».
//
// Дальше по конвейеру `apps/server/src/ops/permissions.ts`
// (`classifyAction`) и `apps/server/src/ws/gateway.ts` (`isOwn`) смотрят
// только на ПЕРВУЮ запись дельты, чтобы классифицировать действие и
// проверить владение — если схема пропускает дельту с двумя сущностями,
// вторая (чужая) запись проходит без проверки прав вообще. Этот файл
// проверяет только уровень схемы (`packages/protocol`); полный сквозной
// сценарий через реальный WS + Postgres — `ws.int.test.ts`.
//
// Тесты написаны ДО исправления схемы и кодируют ЖЕЛАЕМОЕ (после фикса)
// поведение: три «дыры» ниже утверждают `success: false` и падают СЕЙЧАС
// именно потому, что схема пропускает их как `success: true` (дыра, не
// желаемое поведение). После добавления недостающего `.refine` про единство
// `key.entity`/`created[0].id` они должны стать зелёными. Два контрольных
// теста — честные дельты одной сущности — обязаны быть `success: true` и
// до, и после фикса; если после фикса хоть один из них станет `false`, это
// означает, что исправление ослабило схему для легитимных операций, а не
// просто закрыло дыру для поддельных.
//
// `packages/protocol/src/wire.ts` прочитан целиком (это контракт-схема, а
// не «реализация задачи под тестом» — читать можно и нужно, как и
// `packages/crdt/src/index.ts`/`types.ts`). `apps/server/src/ops/**`,
// `apps/server/src/ws/**` не читались — их поведение описано заказчиком
// теста, дальнейшее чтение не требуется.

import type { Dot, EntityId, WireDelta } from "@retro/crdt";
import {
  createGroup,
  createSticker,
  deleteEntity,
  dotKey,
  editText,
  empty,
  newClock,
  setColor,
  setGroup,
  toWire,
} from "@retro/crdt";
import { clientDeltaSchema } from "@retro/protocol";
import { describe, expect, it } from "vitest";

const newActor = () => crypto.randomUUID();

/** Синтетический (ещё не существующий) id сущности — схема не проверяет
 * существование цели (это V3, отдельное правило сервера, не здесь). */
const fakeEntityId = (): EntityId => `${crypto.randomUUID()}:1`;

function stickerFixture(text: string) {
  const actor = newActor();
  const created = createSticker(empty(), newClock(actor), {
    column: "start",
    frac: "m",
    text,
    color: "yellow",
  });
  return {
    actor,
    clock: created.clock,
    id: dotKey(created.dot) as EntityId,
    state: created.delta,
  };
}

/**
 * Минимальная реалистичная подделка одной записи: dot + stamp.actor
 * переписываются на чужой (тот же приём, что уже использует
 * apps/server/test/validate.test.ts для supersedes/stamp). Так честно
 * построенная запись второй сущности начинает нести dot первой операции.
 */
function forgeEntryDot(
  entry: WireDelta["entries"][number],
  dot: Dot,
): WireDelta["entries"][number] {
  return { ...entry, dot, stamp: { ...entry.stamp, actor: dot.actor } };
}

describe("V2 (форма), находка code-review: clientDeltaSchema должна отвергать дельту, чьи записи относятся к разным сущностям", () => {
  it("V2, находка 1 (assignGroup + скрытая правка text чужой сущности): СЕЙЧАС success:true — дыра, схема не проверяет единство entity", () => {
    const x = stickerFixture("sticker X");
    const y = stickerFixture("sticker Y");

    // Честная часть: "assignGroup(X, g)" — participant в фазе group.
    const assign = setGroup(x.state, x.clock, x.id, fakeEntityId());
    const assignWire = toWire(assign.delta);

    // Нечестная часть: "editText(Y, ...)" — должна требовать отдельных прав
    // на Y, но подменяем dot/stamp на dot "честной" операции над X.
    const stealthEdit = editText(y.state, y.clock, y.id, "hacked via assignGroup(X)");
    const stealthWire = toWire(stealthEdit.delta);

    const forgedDelta: WireDelta = {
      created: [],
      entries: [
        ...assignWire.entries,
        ...stealthWire.entries.map((entry) => forgeEntryDot(entry, assign.dot)),
      ],
      supersedes: [...assignWire.supersedes, ...stealthWire.supersedes],
      votes: [],
      unvotes: [],
    };

    const result = clientDeltaSchema.safeParse(forgedDelta);
    // Желаемое (после фикса V2) поведение: дельта на две сущности под одним
    // dot должна быть отвергнута схемой. Красный СЕЙЧАС: X и Y — две разные
    // сущности под одним dot, а схема считает это "одной операцией"
    // (operationDots.size === 1 — единственная проверка, которая есть) и
    // пропускает (`success: true`), хотя должна отвергать.
    expect(result.success).toBe(false);
  });

  it("V2, находка 2 (createSticker + скрытое deleted=true на чужой сущности): должна быть success:false; сейчас success:true — дыра, тест красный", () => {
    const own = createSticker(empty(), newClock(newActor()), {
      column: "start",
      frac: "own",
      text: "my own new sticker",
      color: "green",
    });
    const ownWire = toWire(own.delta);

    const y = stickerFixture("sticker Y");
    const del = deleteEntity(y.state, y.clock, y.id);
    const delWire = toWire(del.delta);
    const [victimEntry] = delWire.entries;
    if (!victimEntry) throw new Error("expected deleteEntity to produce exactly one entry");
    const [ownStampSource] = ownWire.entries;
    if (!ownStampSource) throw new Error("expected createSticker to produce entries");

    const forgedDelta: WireDelta = {
      created: ownWire.created,
      entries: [...ownWire.entries, { ...victimEntry, dot: own.dot, stamp: ownStampSource.stamp }],
      supersedes: [...ownWire.supersedes, ...delWire.supersedes],
      votes: [],
      unvotes: [],
    };

    const result = clientDeltaSchema.safeParse(forgedDelta);
    // Желаемое (после фикса) поведение: success:false. Красный СЕЙЧАС —
    // сервер (classifyAction по created[0]) счёл бы это createSticker и
    // разрешил бы участнику без проверки прав на Y вообще.
    expect(result.success).toBe(false);
  });

  it("V2, находка 3 (createGroup + запись на существующий чужой стикер): должна быть success:false; сейчас success:true — дыра, classifyAction не распознаёт форму вообще, права не проверяются никак, тест красный", () => {
    const group = createGroup(empty(), newClock(newActor()), {
      column: "start",
      frac: "g",
      title: "sneaky group",
    });
    const groupWire = toWire(group.delta);

    const y = stickerFixture("sticker Y2");
    const edit = setColor(y.state, y.clock, y.id, "blue");
    const editWire = toWire(edit.delta);
    const [victimEntry] = editWire.entries;
    if (!victimEntry) throw new Error("expected setColor to produce exactly one entry");
    const [groupStampSource] = groupWire.entries;
    if (!groupStampSource) throw new Error("expected createGroup to produce entries");

    const forgedDelta: WireDelta = {
      created: groupWire.created,
      entries: [
        ...groupWire.entries,
        { ...victimEntry, dot: group.dot, stamp: groupStampSource.stamp },
      ],
      supersedes: [...groupWire.supersedes, ...editWire.supersedes],
      votes: [],
      unvotes: [],
    };

    const result = clientDeltaSchema.safeParse(forgedDelta);
    // Желаемое (после фикса) поведение: success:false. Красный СЕЙЧАС —
    // классификатор действия вообще не узнаёт форму "createGroup + чужая
    // запись" ни как одну из известных операций: проверка прав не
    // выполняется совсем, а не просто "не для той сущности".
    expect(result.success).toBe(false);
  });
});

describe("V2 (форма), контроль: честные дельты одной сущности остаются success:true (и до, и после фикса)", () => {
  it("контроль A: честная createSticker-дельта (1 created + 5 entries, все одной новой сущности) — success:true", () => {
    const created = createSticker(empty(), newClock(newActor()), {
      column: "start",
      frac: "m",
      text: "honest sticker",
      color: "purple",
    });

    const result = clientDeltaSchema.safeParse(toWire(created.delta));
    expect(result.success).toBe(true);
  });

  it("контроль B: честная write-дельта (editText на существующую сущность, entries без created) — success:true", () => {
    const target = stickerFixture("target");
    const honestWrite = editText(target.state, target.clock, target.id, "edited honestly");

    const result = clientDeltaSchema.safeParse(toWire(honestWrite.delta));
    expect(result.success).toBe(true);
  });
});
