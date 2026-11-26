/** @jsxRuntime automatic */
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { Text } from "react-email";
import { Button, emailText, message } from "./email.js";

export function communityTemplateAdminEmail(
  to: string,
  submission: { name: string; version: number },
  reviewUrl: string,
): Promise<TransactionalEmail> {
  return message(
    to,
    "en",
    `New shared agent: ${submission.name}`,
    <>
      <Text>
        {submission.name}, version {submission.version}
      </Text>
      <Button href={reviewUrl}>Review</Button>
    </>,
  );
}

/** Tells the author what happened to their shared agent; the reason is the admin's own words. */
export function communityTemplateReviewedEmail(
  submission: {
    email: string;
    name: string;
    status: "approved" | "rejected" | "unlisted";
    reason: string | null;
  },
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  const name = submission.name;
  return message(
    submission.email,
    locale,
    say("Your shared agent: {name}", { name }),
    <>
      <Text>
        {submission.status === "approved"
          ? say("{name} is now listed in the Superbot Store.", { name })
          : submission.status === "rejected"
            ? say("We couldn't list {name} in the Superbot Store.", { name })
            : say("{name} is no longer listed in the Superbot Store.", { name })}
      </Text>
      {submission.reason ? <Text>{submission.reason}</Text> : null}
    </>,
  );
}
