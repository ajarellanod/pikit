import { expect, test } from "bun:test";
import { emailErrorDetail, emailMessageProblem, isEmailAddress, isEmailFrom } from "./email.ts";

const MESSAGE = { to: "ana@example.com", subject: "Your link", text: "Open https://x.example/verify?token=t0k to sign in." };

test("an address is one plain address", () => {
  for (const good of ["ana@example.com", "ana.b+chat@mail.example.co.uk"]) expect(isEmailAddress(good)).toBe(true);
  for (const bad of ["", "ana", "ana@example", "Ana <ana@example.com>", "ana@example.com, bo@example.com", "ana@example.com\nbcc:x@y.z", `${"a".repeat(250)}@example.com`, 42]) {
    expect(isEmailAddress(bad)).toBe(false);
  }
});

test("a sender is an address, or a name and an address in angle brackets", () => {
  for (const good of ["bot@example.com", "Assistant <bot@example.com>", "<bot@example.com>", " Assistant  < bot@example.com > "]) expect(isEmailFrom(good)).toBe(true);
  for (const bad of ["Assistant", "Assistant <bot>", "Assistant <bot@example.com", "A\nB <bot@example.com>", "a@example.com, b@example.com"]) expect(isEmailFrom(bad)).toBe(false);
});

test("a message's problem names what is wrong, never its content", () => {
  expect(emailMessageProblem(MESSAGE)).toBeUndefined();
  expect(emailMessageProblem({ ...MESSAGE, html: "<p>hi</p>" })).toBeUndefined();
  expect(emailMessageProblem({ ...MESSAGE, to: "nope" })).toBe("the recipient is not one email address");
  expect(emailMessageProblem({ ...MESSAGE, subject: "" })).toBe("the subject is empty");
  expect(emailMessageProblem({ ...MESSAGE, subject: "a\rb" })).toBe("the subject has a line break");
  expect(emailMessageProblem({ ...MESSAGE, text: " " })).toBe("the text is empty");
  expect(emailMessageProblem({ ...MESSAGE, html: 1 as unknown as string })).toBe("the html is not a string");
  expect(emailMessageProblem(undefined as unknown as typeof MESSAGE)).toBe("the recipient is not one email address");
});

test("an API's detail loses its links, is dropped when it quotes the message, and is cut", () => {
  expect(emailErrorDetail("Verify your domain on https://resend.com/domains please", MESSAGE)).toBe("Verify your domain on [link] please");
  expect(emailErrorDetail(`Rejected: ${MESSAGE.subject}`, MESSAGE)).toBe("");
  expect(emailErrorDetail(`Rejected body: ${MESSAGE.text}`, MESSAGE)).toBe("");
  expect(emailErrorDetail("x".repeat(400), MESSAGE)).toBe(`${"x".repeat(300)}...`);
});
