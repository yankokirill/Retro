// Голоса у стикера — docs/design/T-017-voting-ui.md § 2, REQ-015 кр. 5: сумма видна всем, «мои» — только себе.

export interface VoteControlsProps {
  readonly total: number;
  readonly mine: number;
  readonly remaining: number;
  readonly interactive: boolean;
  readonly onVote: () => void;
  readonly onUnvote: () => void;
}

export function VoteControls({
  total,
  mine,
  remaining,
  interactive,
  onVote,
  onUnvote,
}: VoteControlsProps) {
  return (
    <fieldset aria-label="Голоса" className="votes">
      <span data-total>Голоса: {total}</span>
      {mine > 0 && <span data-mine>Мои: {mine}</span>}
      {interactive && (
        <>
          <button
            type="button"
            aria-label="Отдать голос"
            disabled={remaining <= 0}
            onClick={onVote}
          >
            +1
          </button>
          <button
            type="button"
            aria-label="Отозвать голос"
            disabled={mine === 0}
            onClick={onUnvote}
          >
            −1
          </button>
        </>
      )}
    </fieldset>
  );
}
