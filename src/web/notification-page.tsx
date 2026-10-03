import type { NotificationPreferencesViewModel } from "./types";

const categories = [
  { id: "questions", label: "New questions requiring an answer" },
  { id: "stopped", label: "Issues entering blocked, error, needs intervention, or rejected" },
  { id: "done", label: "Issues reaching done" },
] as const;

export function Notifications({ preferences, csrfToken }: { preferences: NotificationPreferencesViewModel; csrfToken: string }) {
  return (
    <section class="settings-page" aria-labelledby="notifications-heading">
      <header class="section-heading settings-heading">
        <div>
          <h2 id="notifications-heading">Notifications</h2>
          <p>Choose which Conveyor events should send a browser notification.</p>
        </div>
      </header>
      <section class="settings-section settings-section--form" aria-labelledby="browser-notifications-heading">
        <div>
          <h3 id="browser-notifications-heading">Browser notifications</h3>
          <p>Permission is requested only when you enable a category. Browser push requires a supported browser and HTTPS.</p>
          <p id="notification-status" class="settings-status" role="status" aria-live="polite">Checking browser support…</p>
        </div>
        <form id="notification-settings" class="settings-form notification-form" data-csrf={csrfToken}>
          <fieldset class="notification-options">
            <legend>Notify me when</legend>
            {categories.map((category) => (
              <label key={category.id}>
                <input type="checkbox" name={category.id} checked={preferences[category.id]} />
                <span>{category.label}</span>
              </label>
            ))}
          </fieldset>
          <div class="settings-actions"><button type="submit">Save notification settings</button></div>
        </form>
      </section>
    </section>
  );
}
