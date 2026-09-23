// Тексты отказов для пользователя (REQ-024 кр. 2) — docs/spec/protocol.md § «Причины отказа».

const REASONS: Record<string, string> = {
  stale_dot: "Действие устарело — обновите страницу",
  invalid_shape: "Некорректные данные: проверьте длину текста",
  unknown_target: "Этого объекта больше нет на доске",
  unjustified_supersede: "Правка конфликтует с более новой",
  invalid_stamp: "Часы устройства рассинхронизированы — обновите страницу",
  forbidden: "Ваша роль не позволяет это действие",
  wrong_phase: "В текущей фазе ретро это действие недоступно",
  vote_limit: "Голоса закончились",
  not_own_vote: "Можно отозвать только свой голос",
  irreversible_phase: "К прошлой фазе вернуться нельзя",
  rate_limited: "Слишком часто — подождите немного",
  too_large: "Слишком большое сообщение",
};

export function describeRejection(reason: string): string {
  return REASONS[reason] ?? "Действие отклонено сервером";
}
