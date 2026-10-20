---
section: Changed
---

The dashboard now runs in the browser. It loads the board once and then applies live changes as they arrive, so an open dashboard no longer reloads its page or asks the server for anything to stay current. Moving between views and opening an item does not load a page either. While it loads you see a skeleton of the board instead of a blank page. Every address and bookmark still works, an item's address can name its tab, and the preview addresses under `/app` redirect to the same view. Searching the Board still finds finished items older than the 50 it holds. The dashboard now needs JavaScript; the sign-in page does not. `/events/dashboard` and `/assets/dashboard.js` are gone.
