# Contributing

Morph Factory is an integration experiment. Small changes are easiest to evaluate when they include an observable outcome on a real checkout.

1. Start from `main` and create a topic branch.
2. Reproduce the behavior on a named commit. The VibeCheck fixture in the README is available without Spotify credentials.
3. Keep the application change and its relevant regression check together. For release changes, exercise a tab that was already open before approval.
4. Run `python -m unittest discover -s tests -v` from the repository root. Include any additional checks for the component you changed.
5. Open a pull request describing the result, how you verified it, and what you could not verify.

Keep upstream code attributable. When updating vendored LLP files, pin the upstream commit, retain its license, describe local changes, and record the compatibility result in the experiment notes. Please use synthetic events or your own public fixtures in shared screenshots and logs.
