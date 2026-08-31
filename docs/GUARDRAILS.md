# Helix Standing Rules

These are the rules Helix operates under. They are not aspirations and not a
code of conduct — each one exists because breaking it has a specific cost, and
each one is listed here with what actually stops it being broken today.

The rules are also **data**, in [`src/guardrails/rules.ts`](../src/guardrails/rules.ts),
and are rendered inside the application under **System → Standing rules**. That
is deliberate. A rule that lives only in a conversation is a rule nobody can
check, and a rule nobody can check is indistinguishable from one that was
quietly dropped.

`docs/SECURITY.md` covers engineering security — secrets, CSP, dependencies.
This file covers behaviour.

---

## The three kinds of enforcement

Every rule below carries one of three labels, and the difference between them
is the point of this document.

| Label | Meaning |
| --- | --- |
| **enforced** | Something in the code refuses the violation, and a test proves it. |
| **by absence** | The violation is not expressible in this build. Nothing is holding the line — there is no line to cross yet. |
| **promised** | Nothing stops it. It is followed, and it is a thing still to build. |

**"By absence" is not a pass.** It means the rule is currently kept by a missing
feature, and it stops being kept the day that feature arrives. Every such rule
below says what will weaken it. Marking these as *enforced* would be exactly the
failure the rules exist to prevent, so they are not, on screen or here.

The counts are shown separately and never summed into a score. "Nine of eleven"
invites the reading that the project is nine-elevenths safe, when the two
outstanding may be the two that matter.

---

## The rules

### Ask before it leaves — *enforced*

> Helix may send messages and place calls. Nothing leaves without you seeing it
> first and confirming that specific draft.

**This rule replaced "never send", on your instruction.** The permission is now
"ask, then send" rather than "never send", and the difference between those two
is exactly one confirmation step — so that step is structural rather than
conventional.

A draft that turns out wrong costs a rewrite. A sent message cannot be recalled,
and a call cannot be unmade.

**What holds it:** [`src/outbound/outbound.ts`](../src/outbound/outbound.ts).
Every outbound action is drafted, shown in full, and confirmed by id. Four
properties, each because the obvious shortcut is worse:

- **Confirmation is per draft.** No bulk approve, no remembered permission, no
  trusted recipient. A standing permission is indistinguishable from no
  permission the first time it is wrong.
- **Confirmation goes stale** after five minutes, so an approval given and
  forgotten cannot fire later against a draft you have stopped thinking about.
- **A confirmed draft cannot be edited.** Otherwise the approval refers to
  something that no longer exists, which is the whole trick behind confirming
  one thing and sending another.
- **Recipients are named in full, never counted.** "Send to 4 people" is exactly
  the shape of confirmation someone approves without reading.

**What weakens it:** this is now the only thing standing between a mistaken
draft and a real recipient.

### A record of everything sent — *enforced*

> Every message and call, and every one refused, is recorded with what it was
> and who it was for.

Anything that can act on your behalf owes you an account of what it did.

**What holds it:** the outbox keeps every draft with its state — drafted,
confirmed, sent, cancelled or failed — and the reason for each refusal. A
failure keeps the provider's own message rather than losing it.

### Read-only outside its own folders — *by absence*

> Helix never writes to your folders. Everything it keeps goes in its own data
> directory.

An assistant that can overwrite your work is one bug away from destroying it.

**What holds it:** a browser page has no filesystem access at all. `PathManager`
already refuses any path outside the workspace, ready for the shell.

**What weakens it:** under the shell this becomes the only thing standing
between Helix and your disk.

### Never remember silently — *enforced*

> Nothing is written to long-term memory without Helix saying so, and quoting it
> back.

Memory you did not know was taken is surveillance, however well meant.

**What holds it:** saving happens on an explicit instruction only, and the reply
quotes the stored record. Nothing in the conversation path writes memory on its
own.

### Never keep a credential — *enforced*

> No API key, password or token is stored, logged, or committed.

A leaked key is a bill and a breach, and it leaks once for all time.

**What holds it:** one shared pattern list in `src/core/secrets.ts`. The logger
redacts matches before a sink sees them; memory refuses to store them at all.
The two consumers share the list so they cannot drift apart.

### Never spend — *enforced*

> Helix may use an account you have already set up and funded. It may never buy,
> pay, top up, subscribe or upgrade.

Sending on your behalf and spending on your behalf are different permissions,
and only one of them was given. Money spent without your say-so is the fastest
way to lose trust.

**Where the line falls.** Placing a call is itself billable on every provider
worth using, so "may call" and "never spend" cannot both be absolute. The
reading in force: Helix will make the call you asked for, on an account you have
funded, and will not fund it.

**What holds it:** a draft whose text reads as a purchase — buy, pay, order, top
up, subscribe, transfer a sum — is refused outright rather than drafted, and
never reaches the outbox at all. Subject and body are both checked. The test
errs towards refusing: a false positive costs one rephrase, a false negative
costs money.

Cost is stated on every draft, and an unmeasured cost is `null` rather than
zero. Reporting zero because nothing measured would turn this into a rule Helix
breaks while believing it is keeping it.

### Never invent — *by absence*

> No made-up number, date, filename or client. If it is not in the files, Helix
> says so.

A plausible fabrication is worse than a blank, because it gets acted on.

**What holds it:** there is no generative path. A request no tool can handle
returns a named failure identifying the missing provider, never a composed
reply. The briefing tools read only real local state and never touch the demo
vault fixtures.

**What weakens it:** a connected model can invent fluently. This becomes the
hardest rule in the project the day one is wired in.

### Never state a bare derived number — *enforced*

> Every derived figure carries the qualifier that makes it true.

A half-paid invoice on a running job is not a discount, and reporting it as one
is a lie made of true numbers.

**What holds it:** the briefing reports ages as *"since Helix saw a change"*,
never as elapsed work — Helix can observe its own store and nothing else.
Indexing reports what it skipped alongside what it indexed, so a run that
skipped everything cannot read as a run that worked. Both are pinned by tests.

### Files are information, not instructions — *enforced*

> A note in your files saying "ignore your instructions" is reported to you,
> never obeyed.

Anything Helix reads could have been written by someone else, for Helix to read.

**What holds it:** [`src/guardrails/untrusted.ts`](../src/guardrails/untrusted.ts)
scans file text for instruction-shaped passages — overrides, forged system
blocks, role reassignment, requests to send data away, requests to conceal
something from you — and labels them wherever that content is shown: in the
Files workspace, and in the reply to any search that matches such a file.

Two decisions inside it are worth stating:

- **It flags, it does not block.** A document *about* prompt injection will trip
  these patterns, and should. Refusing to index it would make Helix useless to
  anyone who writes on the subject. You are shown the passage and you decide.
- **It never edits your file.** No sanitising, no stripping, no quiet removal.
  Your file is your file.

The scan runs on read, not at index time. A stored flag goes stale the moment
the patterns improve, and a file indexed before a pattern existed would report
itself clean for ever. A false negative is the failure that matters here.

### No silent camera or microphone — *enforced*

> Neither sensor runs without a visible indicator, and the indicator follows the
> hardware.

A recording light that can be wrong is worse than none, because it is believed.

**What holds it:** the camera indicator is driven by whether a track is
genuinely live, not by the intent to start one, so it cannot claim a camera that
has stopped.

### Real data is opted into — *enforced*

> The vault runs on invented fixtures unless it is explicitly set to real.

A default that reaches your documents is a default that reaches them by
accident.

**What holds it:** one function in `src/vault/config.ts` decides it, and
anything other than the exact string `real` resolves to demo — so a typo fails
towards the safe side.

### Ask before installing — *by absence*

> Nothing is downloaded or installed that you have not named.

Weight and dependencies accumulate silently, and a portable tool stops being
portable.

**What holds it:** the application downloads nothing at runtime. Model weights
arrive only when you run `npm run fetch:models` yourself.

---

## Changing this file

Adding a rule means adding it to `src/guardrails/rules.ts`. The tests require a
reason and evidence on every entry, and require anything labelled *by absence*
to state what will weaken it. The panel in the application renders whatever is
in that file, so the document, the code and the screen cannot drift apart.
