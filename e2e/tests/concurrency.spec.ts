// T-022 — конкурентность в настоящих браузерах: REQ-007 (одновременная правка текста),
// REQ-008 (одновременное перемещение), REQ-023 (работа без сети и досылка после восстановления).
// Три контекста одной доски; третий теряет связь, правит и двигает стикер, пока остальные тоже правят.
// Итог — одинаковый DOM у всех трёх.

import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";

const COLUMNS = ["Начать", "Прекратить", "Продолжать"] as const;

interface NetworkControl {
  /** Рвёт текущие WebSocket страницы и отклоняет новые, пока не вызван `restore`. */
  cut(): void;
  restore(): void;
}

/** Перехват WebSocket страницы: единственный способ надёжно «отключить сеть» у уже открытого сокета. */
async function controlNetwork(page: Page): Promise<NetworkControl> {
  let offline = false;
  const open = new Set<{ close(): void }>();
  await page.routeWebSocket(/\/api\/boards\/.*\/ws/, (ws) => {
    if (offline) {
      ws.close();
      return;
    }
    const server = ws.connectToServer();
    open.add(ws);
    open.add(server);
  });
  return {
    cut() {
      offline = true;
      for (const socket of open) socket.close();
      open.clear();
    },
    restore() {
      offline = false;
    },
  };
}

interface CardState {
  id: string;
  color: string | null;
  variants: string[];
}
type BoardState = Record<string, CardState[]>;

/** Что видит пользователь: по колонкам — стикеры с id, цветом и всеми вариантами текста. */
async function boardState(page: Page): Promise<BoardState> {
  return page.evaluate(
    (columns) => {
      const result: Record<string, { id: string; color: string | null; variants: string[] }[]> = {};
      for (const name of columns) {
        const section = document.querySelector(`section[aria-label="${name}"]`);
        result[name] = [...(section?.querySelectorAll("article[data-card-id]") ?? [])].map(
          (card) => ({
            id: card.getAttribute("data-card-id") ?? "",
            color: card.getAttribute("data-color"),
            variants: [...card.querySelectorAll("p[data-variant]")].map((p) => p.textContent ?? ""),
          }),
        );
      }
      return result;
    },
    [...COLUMNS],
  );
}

async function newUser(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  return { context, page };
}

async function createBoardAsOwner(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByLabel("Название").fill("Ретро e2e");
  await page.getByLabel("Ваше имя").fill("Аня");
  await page.getByRole("button", { name: "Создать доску" }).click();
  const linkLine = await page.getByText(/Ссылка для участников:/).textContent();
  const link = linkLine?.match(/https?:\/\/\S+/)?.[0];
  if (!link) throw new Error(`нет ссылки участника: ${linkLine}`);
  await page.getByRole("button", { name: "Открыть доску" }).click();
  await expect(page.locator('.status[data-status="welcomed"]')).toBeVisible();
  return link;
}

async function joinAs(page: Page, link: string, name: string): Promise<void> {
  await page.goto(link);
  await page.getByLabel("Ваше имя").fill(name);
  await page.getByRole("button", { name: "Продолжить" }).click();
  await expect(page.locator('.status[data-status="welcomed"]')).toBeVisible();
}

const column = (page: Page, name: (typeof COLUMNS)[number]) =>
  page.locator(`section[aria-label="${name}"]`);

async function addSticker(page: Page, name: (typeof COLUMNS)[number], text: string): Promise<void> {
  await column(page, name).getByLabel("Новый стикер").fill(text);
  await column(page, name).getByRole("button", { name: "Добавить" }).click();
}

async function editText(page: Page, text: string): Promise<void> {
  await page.getByRole("button", { name: "Редактировать" }).click();
  await page.getByLabel("Текст стикера").fill(text);
  await page.getByRole("button", { name: "Сохранить" }).click();
}

/** Перетаскивание за ручку в другую колонку (PointerSensor dnd-kit: нужны реальные движения мыши). */
async function dragToColumn(page: Page, to: (typeof COLUMNS)[number]): Promise<void> {
  const handle = page.locator(".handle").first();
  const target = column(page, to).locator(".column-body");
  const from = await handle.boundingBox();
  const dest = await target.boundingBox();
  if (!from || !dest) throw new Error("нет координат для перетаскивания");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, from.y + 20, { steps: 5 });
  await page.mouse.move(dest.x + dest.width / 2, dest.y + Math.min(dest.height / 2, 30), {
    steps: 15,
  });
  await page.mouse.up();
}

test("REQ-007/008/023: правка и перемещение одного стикера тремя участниками, один офлайн — одинаковый DOM", async ({
  browser,
}) => {
  const a = await newUser(browser);
  const b = await newUser(browser);
  const c = await newUser(browser);
  try {
    const net = await controlNetwork(c.page);

    // Участник правит только свои стикеры (REQ-007 кр. 3), поэтому B и C — фасилитаторы: их правка
    // чужого стикера разрешена, и конфликт текста возможен.
    // Владелец создаёт доску и стикер (фаза collect), затем раскрывает — иначе чужие стикеры скрыты.
    const link = await createBoardAsOwner(a.page);
    await addSticker(a.page, "Начать", "Исходный");
    await expect(column(a.page, "Начать").locator("article[data-card-id]")).toHaveCount(1);
    await a.page.getByRole("button", { name: "Группировка" }).click();
    await a.page.getByRole("button", { name: "Подтвердить" }).click();

    await joinAs(b.page, link, "Боря");
    await joinAs(c.page, link, "Вера");
    for (const { page } of [a, b, c]) {
      await expect(column(page, "Начать").locator("article[data-card-id]")).toHaveCount(1);
    }
    await a.page.getByRole("button", { name: "Обновить список" }).click();
    for (const [name, { page }] of [
      ["Боря", b],
      ["Вера", c],
    ] as const) {
      await a.page.getByRole("button", { name: `Назначить фасилитатором: ${name}` }).click();
      await expect(page.getByRole("button", { name: "Голосование" })).toBeVisible();
      await a.page.getByRole("button", { name: "Обновить список" }).click();
    }

    // Третий теряет связь; теперь его правки не видны остальным, а их — ему.
    net.cut();
    await expect(c.page.locator('.status[data-status="offline"]')).toBeVisible();

    await editText(c.page, "Вариант В");
    await dragToColumn(c.page, "Продолжать");
    await editText(b.page, "Вариант Б");
    await dragToColumn(b.page, "Прекратить");

    // Пока C офлайн, A и B сошлись между собой, а C видит только своё.
    await expect(b.page.locator("p[data-variant]")).toHaveCount(1);
    await expect(c.page.locator("p[data-variant]")).toHaveText("Вариант В");

    // Связь вернулась: очередь C уходит на сервер, C получает чужое.
    net.restore();
    await expect(c.page.locator('.status[data-status="welcomed"]')).toBeVisible({
      timeout: 30_000,
    });

    // Конфликт текста показан у всех (REQ-007 кр. 1), никто не потерян.
    for (const { page } of [a, b, c]) {
      await expect(page.locator("p[data-variant]")).toHaveCount(2);
      await expect(page.getByRole("alert").filter({ hasText: "Конфликт правок" })).toBeVisible();
    }

    // Одинаковое состояние доски у всех трёх (REQ-008: стикер ровно в одной колонке, одной у всех).
    await expect
      .poll(
        async () =>
          JSON.stringify(await boardState(a.page)) === JSON.stringify(await boardState(c.page)),
      )
      .toBe(true);
    const stateA = await boardState(a.page);
    expect(await boardState(b.page)).toEqual(stateA);
    expect(await boardState(c.page)).toEqual(stateA);

    const cards = COLUMNS.flatMap((name) => stateA[name] ?? []);
    expect(cards).toHaveLength(1);
    expect([...(cards[0]?.variants ?? [])].sort()).toEqual(["Вариант Б", "Вариант В"]);
    const where = COLUMNS.filter((name) => (stateA[name] ?? []).length > 0);
    expect(where).toHaveLength(1);
    expect(["Прекратить", "Продолжать"]).toContain(where[0]);
  } finally {
    await Promise.all([a, b, c].map(({ context }) => context.close()));
  }
});
