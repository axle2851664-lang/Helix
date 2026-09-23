# UI harness

This project has no jsdom or testing-library, by choice: component logic lives
in plain `.ts` modules with real tests, and the components themselves get
looked at in a browser. That leaves one gap - *interaction*. A screen can
render correctly and still send the wrong thing when a button is pressed.

This directory closes that gap. It mounts a single workspace against a fake
`useHelix()` and drives it with Playwright. It earned its place immediately:
the inbox screen infinite-looped on mount (an effect depending on a callback
whose identity follows the services object) and sent message ids as an array
where the action layer takes a comma-separated string. Both typechecked, both
passed every unit test either side owned, and both would have failed in front
of the user.

## Running it

```
npx vite --config .harness/vite.config.ts --port 4199
```

Then open `http://localhost:4199/inbox.html`, or drive it from a script.

## The boundary

`stubProvider.tsx` returns a fake mailbox and a fake action runner. **Nothing
in `src/` may import anything from here.** That is enforced by construction
rather than by discipline: `tsconfig.app.json` includes only `src`, and the
production build starts from `index.html`, so this directory is invisible to
both. A test in `src/core/source-hygiene.test.ts` holds the same line from the
other side.

The alias is anchored (`/^.*HelixProvider\.js$/`) on purpose. An unanchored
regex replaces only the matched tail and leaves the `../` prefix in front of
an absolute path, which fails to resolve in a way that reads like a missing
file.
