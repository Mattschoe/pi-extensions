# pi-auto-name-session

## What it does
Gives an unnamed session a short, descriptive name based on your first prompt. The name comes from a
`name_session` tool call made by the agent already answering you, so no extra model request is spent
on it.

## Reason
Its annoying to name each session, and even more annoying to try and find a chat when you have a list full on `unnamed` sessions. 

## Install
```sh
pi install npm:pi-auto-name-session
```

## Behaviour

The name comes from a `name_session` tool call made by the agent already answering you, so no extra
model request is spent on it.

On the first prompt of an unnamed session a one-time instruction is appended to the system prompt
asking for that call. A session that already has a name — resumed, continued, or started with
`pi --name "..."` — is left alone, and nothing is injected for the rest of it either way.

## Example
<img width="397" height="196" alt="image" src="https://github.com/user-attachments/assets/0d5e701e-bd14-4606-8623-e2f66f0f0cdc" />
