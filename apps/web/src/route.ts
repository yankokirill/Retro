// Маршруты SPA — docs/design/T-015-board-ui.md § 2.

export type Route =
  | { readonly name: "home" }
  | { readonly name: "join"; readonly linkToken: string }
  | { readonly name: "board"; readonly boardId: string }
  | { readonly name: "notFound" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseRoute(pathname: string): Route {
  const segments = pathname.replace(/\/+$/, "").split("/").slice(1);
  if (segments.length === 0) return { name: "home" };
  const [head, value, ...extra] = segments;
  if (extra.length > 0 || value === undefined || value === "") return { name: "notFound" };
  if (head === "j") return { name: "join", linkToken: decodeURIComponent(value) };
  if (head === "b" && UUID.test(value)) return { name: "board", boardId: value };
  return { name: "notFound" };
}

export const boardPath = (boardId: string): string => `/b/${boardId}`;
export const joinPath = (linkToken: string): string => `/j/${encodeURIComponent(linkToken)}`;
