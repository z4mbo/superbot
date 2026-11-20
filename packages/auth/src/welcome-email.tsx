/** @jsxRuntime automatic */
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { Text } from "react-email";
import { emailText, greeting, message } from "./email.js";

export function welcomeEmail(
  user: { email: string; name: string },
  unsubscribeUrl: string,
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  return message(
    user.email,
    locale,
    say("Welcome to Superbot"),
    <>
      <Text>{greeting(say, user.name)}</Text>
      <Text>{say("Welcome to Superbot")}</Text>
    </>,
    unsubscribeUrl,
  );
}
