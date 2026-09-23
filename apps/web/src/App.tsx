// Маршрутизация и экраны входа: создать доску, войти по ссылке, открыть доску.

import { useCallback, useEffect, useMemo, useState } from "react";
import { type Api, ApiError, createApi } from "./api.js";
import { type BoardRuntime, startBoard } from "./board-runtime.js";
import { boardPath, joinPath, parseRoute } from "./route.js";
import { loadGuestIdentity, saveDisplayName } from "./sync/guest.js";
import { BoardView } from "./ui/BoardView.js";

function useNavigation() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((next: string) => {
    history.pushState(null, "", next);
    setPath(next);
  }, []);
  return { path, navigate };
}

function NameForm({ onName }: { onName: (name: string) => void }) {
  const [name, setName] = useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim() !== "") onName(name.trim());
      }}
    >
      <label>
        Ваше имя
        <input value={name} maxLength={50} onChange={(event) => setName(event.target.value)} />
      </label>
      <button type="submit">Продолжить</button>
    </form>
  );
}

function Home({
  api,
  initialName,
  navigate,
}: {
  api: Api;
  initialName: string | null;
  navigate: (p: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [name, setName] = useState(initialName ?? "");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{
    boardId: string;
    participantLink: string;
    viewerLink: string;
  } | null>(null);

  if (created) {
    return (
      <main>
        <h1>Доска создана</h1>
        <p>Ссылка для участников: {`${location.origin}${joinPath(created.participantLink)}`}</p>
        <p>Ссылка для наблюдателей: {`${location.origin}${joinPath(created.viewerLink)}`}</p>
        <button type="button" onClick={() => navigate(boardPath(created.boardId))}>
          Открыть доску
        </button>
      </main>
    );
  }
  return (
    <main>
      <h1>Retro</h1>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            setError(null);
            const result = await api.createBoard({ title: title.trim(), displayName: name.trim() });
            saveDisplayName(localStorage, name.trim());
            setCreated(result);
          } catch (err) {
            setError(err instanceof ApiError ? err.message : "Не удалось создать доску");
          }
        }}
      >
        <label>
          Название
          <input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label>
          Ваше имя
          <input value={name} maxLength={50} onChange={(event) => setName(event.target.value)} />
        </label>
        <button type="submit" disabled={title.trim() === "" || name.trim() === ""}>
          Создать доску
        </button>
        {error !== null && <div role="alert">{error}</div>}
      </form>
    </main>
  );
}

function Join({
  api,
  linkToken,
  displayName,
  navigate,
}: {
  api: Api;
  linkToken: string;
  displayName: string;
  navigate: (p: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.join(linkToken, displayName).then(
      ({ boardId }) => navigate(boardPath(boardId)),
      () => setError("Ссылка недействительна"),
    );
  }, [api, linkToken, displayName, navigate]);
  return <main>{error ?? "Входим на доску…"}</main>;
}

function Board({ api, boardId, displayName }: { api: Api; boardId: string; displayName: string }) {
  const [runtime, setRuntime] = useState<BoardRuntime | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active: BoardRuntime | null = null;
    let cancelled = false;
    api.getBoard(boardId).then(
      async (board) => {
        if (board === null) return setError("Доска не найдена или у вас нет доступа");
        const started = await startBoard(boardId, displayName);
        if (cancelled) return started.stop();
        active = started;
        setRuntime(started);
      },
      () => setError("Не удалось загрузить доску"),
    );
    return () => {
      cancelled = true;
      active?.stop();
    };
  }, [api, boardId, displayName]);
  if (error !== null) return <main>{error}</main>;
  if (runtime === null) return <main>Загрузка…</main>;
  return <BoardView controller={runtime.controller} />;
}

export function App() {
  const { path, navigate } = useNavigation();
  const identity = useMemo(() => loadGuestIdentity(localStorage, () => crypto.randomUUID()), []);
  const api = useMemo(
    () => createApi({ fetch: (...args) => fetch(...args), guestId: identity.guestId }),
    [identity.guestId],
  );
  const [displayName, setDisplayName] = useState(identity.displayName);
  const route = parseRoute(path);

  const askName = (
    <main>
      <NameForm
        onName={(name) => {
          saveDisplayName(localStorage, name);
          setDisplayName(name);
        }}
      />
    </main>
  );

  switch (route.name) {
    case "home":
      return <Home api={api} initialName={displayName} navigate={navigate} />;
    case "join":
      return displayName === null ? (
        askName
      ) : (
        <Join api={api} linkToken={route.linkToken} displayName={displayName} navigate={navigate} />
      );
    case "board":
      return displayName === null ? (
        askName
      ) : (
        <Board api={api} boardId={route.boardId} displayName={displayName} />
      );
    case "notFound":
      return <main>Страница не найдена</main>;
  }
}
