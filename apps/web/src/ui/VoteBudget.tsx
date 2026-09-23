export function VoteBudget({ remaining, limit }: { remaining: number; limit: number }) {
  return (
    <p role="status" aria-label="Оставшиеся голоса">
      Осталось голосов: {remaining} из {limit}
    </p>
  );
}
