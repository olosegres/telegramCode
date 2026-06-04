interface TelegramErrorLike {
  response?: {
    error_code?: number;
    description?: string;
  };
  on?: {
    method?: string;
  };
}

function checkIsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function checkIsStaleAnswerCallbackQueryError(err: unknown): boolean {
  if (!checkIsRecord(err)) return false;
  const e = err as TelegramErrorLike;
  const description = e.response?.description ?? '';
  return (
    e.response?.error_code === 400 &&
    e.on?.method === 'answerCallbackQuery' &&
    /query is too old|query ID is invalid/i.test(description)
  );
}
