import type { DashboardAccountViewModel } from "./types";

export const PROFILE_AVATARS = ["🐼", "🦊", "🐨", "🐯", "🐸", "🦉", "🐙", "🦁"] as const;

function PageHeading({ id, title, description }: { id: string; title: string; description: string }) {
  return (
    <header class="section-heading settings-heading">
      <div>
        <h2 id={id}>{title}</h2>
        <p>{description}</p>
      </div>
    </header>
  );
}

export function Accounts({ accounts, csrfToken }: { accounts: readonly DashboardAccountViewModel[]; csrfToken: string }) {
  return (
    <section class="settings-page" aria-labelledby="accounts-heading">
      <header class="section-heading settings-heading">
        <div>
          <h2 id="accounts-heading">Accounts</h2>
          <p>Manage the people who can sign in to this Conveyor dashboard.</p>
        </div>
      </header>
      <section class="settings-section" aria-labelledby="account-list-heading">
        <h3 id="account-list-heading">People with access</h3>
        <div class="report-table-wrap">
          <table class="report-table account-table">
            <thead><tr><th scope="col">Account</th><th scope="col">Role</th></tr></thead>
            <tbody data-account-list>
              {accounts.map((account) => (
                <tr key={account.id}>
                  <th scope="row"><span class="account-row-avatar" aria-hidden="true">{account.avatar}</span>{account.username}</th>
                  <td>{account.role === "superuser" ? "Superuser" : "User"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section class="settings-section settings-section--form" aria-labelledby="create-account-heading">
        <div>
          <h3 id="create-account-heading">Create account</h3>
          <p>New accounts start as regular users. Share the initial password securely.</p>
        </div>
        <form class="settings-form" method="post" action="/api/accounts" data-account-create-form>
          <input type="hidden" name="csrf" value={csrfToken} />
          <label for="account-username">Username</label>
          <input id="account-username" name="username" maxLength={64} autoComplete="username" required />
          <label for="account-password">Initial password</label>
          <input id="account-password" type="password" name="password" minLength={12} autoComplete="new-password" required />
          <div class="settings-actions">
            <button type="submit">Create account</button>
            <span role="status" aria-live="polite" data-form-status />
          </div>
        </form>
      </section>
    </section>
  );
}

export function Profile({ account, csrfToken }: { account: DashboardAccountViewModel; csrfToken: string }) {
  return (
    <section class="settings-page" aria-labelledby="profile-heading">
      <PageHeading id="profile-heading" title="Profile" description="Choose how you appear in Conveyor and keep your sign-in secure." />
      <section class="profile-summary" aria-label="Current profile">
        <span class="profile-avatar" data-profile-avatar aria-hidden="true">{account.avatar}</span>
        <div><h3>{account.username}</h3><p>{account.role === "superuser" ? "Superuser" : "User"}</p></div>
      </section>
      <section class="settings-section settings-section--form" aria-labelledby="appearance-heading">
        <div>
          <h3 id="appearance-heading">Appearance</h3>
          <p>Select an avatar, then save your profile without leaving this page.</p>
        </div>
        <form class="settings-form" method="post" action="/api/profile/avatar" data-profile-avatar-form>
          <input type="hidden" name="csrf" value={csrfToken} />
          <fieldset class="avatar-picker">
            <legend>Avatar</legend>
            <div>
              {PROFILE_AVATARS.map((avatar) => (
                <label key={avatar}>
                  <input class="sr-only" type="radio" name="avatar" value={avatar} checked={avatar === account.avatar} />
                  <span aria-hidden="true">{avatar}</span>
                  <span class="sr-only">Choose {avatar}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div class="settings-actions">
            <button type="submit">Save</button>
            <span role="status" aria-live="polite" data-form-status />
          </div>
        </form>
      </section>
      <section class="settings-section settings-section--form" id="change-password" aria-labelledby="password-heading">
        <div>
          <h3 id="password-heading">Change password</h3>
          <p>Changing your password signs out every existing session, including this one.</p>
        </div>
        <form class="settings-form" method="post" action="/api/profile/password">
          <input type="hidden" name="csrf" value={csrfToken} />
          <label for="current-password">Current password</label>
          <input id="current-password" name="currentPassword" type="password" autoComplete="current-password" required />
          <label for="new-password">New password</label>
          <input id="new-password" name="newPassword" type="password" minLength={12} autoComplete="new-password" required />
          <div class="settings-actions"><button type="submit">Change password</button></div>
        </form>
      </section>
    </section>
  );
}
