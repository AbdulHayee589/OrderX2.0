import { useEffect, useState } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useLocation,
  useNavigation,
  useRouteError,
  useSubmit,
} from "react-router";
import { Modal, TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  backendDelete,
  backendGet,
  backendPost,
  backendPut,
} from "../server/backend.server";
import { withShopParams } from "../utils/embedded";

const toArray = (value) => (Array.isArray(value) ? value : []);
const toObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

const AGENT_PERMISSION_OPTIONS = [
  ["viewCustomerPhone", "View customer phone"],
  ["viewCustomerEmail", "View customer email"],
  ["viewShopifyData", "View Shopify customer and orders"],
  ["editContacts", "Edit customer display names"],
  ["manageAssignments", "Assign and transfer conversations"],
  ["manageStatuses", "Change conversation status"],
  ["writeInternalNotes", "Write internal notes"],
  ["sendMessages", "Send text messages"],
  ["sendMedia", "Send images, files, and voice notes"],
  ["sendTemplates", "Send approved WhatsApp templates"],
  ["manageLabels", "Create and apply labels"],
  ["manageQuickReplies", "Create saved quick replies"],
  ["performOrderActions", "Confirm or cancel Shopify orders"],
];

const AGENT_PERMISSION_DESCRIPTIONS = {
  viewCustomerPhone: "Reveal customer phone numbers in the inbox.",
  viewCustomerEmail: "Reveal customer email addresses in the inbox.",
  viewShopifyData: "View matched Shopify customer and order context.",
  editContacts: "Change customer display names for the support team.",
  manageAssignments: "Assign and transfer conversations between agents.",
  manageStatuses: "Open, resolve, and update conversation statuses.",
  writeInternalNotes: "Add private notes that customers never receive.",
  sendMessages: "Send customer-service text replies inside the open window.",
  sendMedia: "Send images, files, audio, and voice notes.",
  sendTemplates: "Send merchant-approved WhatsApp templates.",
  manageLabels: "Create labels and organize conversations with them.",
  manageQuickReplies: "Create and manage the team's saved replies.",
  performOrderActions: "Confirm or cancel matched Shopify orders.",
};

const AGENT_ACCESS_PRESETS = {
  limited: {
    label: "Limited",
    shortLabel: "Focused replies",
    description:
      "Can handle text and approved-template replies without viewing customer contact or Shopify order details.",
    allowed: [
      "manageStatuses",
      "writeInternalNotes",
      "sendMessages",
      "sendTemplates",
    ],
  },
  support: {
    label: "Support",
    shortLabel: "Daily support",
    description:
      "Can manage assigned conversations, customer context, replies, media, and approved WhatsApp templates.",
    allowed: [
      "viewCustomerPhone",
      "viewCustomerEmail",
      "viewShopifyData",
      "manageAssignments",
      "manageStatuses",
      "writeInternalNotes",
      "sendMessages",
      "sendMedia",
      "sendTemplates",
    ],
  },
  manager: {
    label: "Manager",
    shortLabel: "Full workspace",
    description:
      "Full Team Inbox access, including customer edits, labels, quick replies, assignments, and Shopify order actions.",
    allowed: AGENT_PERMISSION_OPTIONS.map(([key]) => key),
  },
};

function getAgentAccessPreset(value) {
  return (
    AGENT_ACCESS_PRESETS[
      String(value || "")
        .trim()
        .toLowerCase()
    ] || AGENT_ACCESS_PRESETS.support
  );
}

function permissionsForAccessPreset(value) {
  const preset = getAgentAccessPreset(value);
  return Object.fromEntries(
    AGENT_PERMISSION_OPTIONS.map(([key]) => [
      key,
      preset.allowed.includes(key),
    ]),
  );
}

function createEmptyAgentDraft() {
  return {
    username: "",
    accessLevel: "support",
    password: "",
    permissions: permissionsForAccessPreset("support"),
  };
}

function permissionsFromForm(form) {
  return Object.fromEntries(
    AGENT_PERMISSION_OPTIONS.map(([key]) => [
      key,
      form.getAll(`permission_${key}`).map(String).includes("true"),
    ]),
  );
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const response = await backendGet("/api/agents", session.shop).catch(
    (error) => ({
      agents: [],
      limit: 3,
      feature: {
        allowed: false,
        code: "agent_service_unavailable",
        reason:
          error?.message ||
          "Agent Accounts could not be verified safely. Please try again.",
      },
    }),
  );
  return {
    agents: toArray(response?.agents),
    limit: Number(response?.limit || 3),
    feature: toObject(response?.feature),
    messengerUrl:
      String(process.env.MESSENGER_APP_URL || "").trim() ||
      "https://orderx.com/messenger/login",
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "").trim();
  const agentId = String(form.get("agentId") || "").trim();

  try {
    if (intent === "create") {
      const response = await backendPost("/api/agents", session.shop, {
        username: String(form.get("username") || "").trim(),
        password: String(form.get("password") || ""),
        accessLevel: String(form.get("accessLevel") || "support"),
        permissions: permissionsFromForm(form),
      });
      return {
        ok: true,
        intent,
        note: `Agent ${response?.agent?.username || "account"} created`,
      };
    }
    if (intent === "update_access") {
      await backendPut(`/api/agents/${agentId}/access`, session.shop, {
        accessLevel: String(form.get("accessLevel") || "support"),
        permissions: permissionsFromForm(form),
      });
      return {
        ok: true,
        intent,
        agentId,
        note: "Agent access updated",
      };
    }
    if (intent === "update_password") {
      await backendPut(`/api/agents/${agentId}/password`, session.shop, {
        password: String(form.get("password") || ""),
      });
      return {
        ok: true,
        intent,
        agentId,
        note: "Agent password updated and old sessions signed out",
      };
    }
    if (intent === "delete") {
      await backendDelete(`/api/agents/${agentId}`, session.shop);
      return { ok: true, intent, agentId, note: "Agent account deleted" };
    }
    return { ok: false, intent, error: "Unsupported action" };
  } catch (error) {
    return {
      ok: false,
      intent,
      agentId,
      error: error?.message || "Agent account action failed",
    };
  }
};

export default function AgentAccountsPage() {
  const { agents, limit, messengerUrl, feature } = useLoaderData();
  const actionData = useActionData();
  const location = useLocation();
  const navigation = useNavigation();
  const submit = useSubmit();
  const shopify = useAppBridge();
  const [editingAgentId, setEditingAgentId] = useState("");
  const [editingAccessAgentId, setEditingAccessAgentId] = useState("");
  const [createDraft, setCreateDraft] = useState(createEmptyAgentDraft);
  const [createConfirmationOpen, setCreateConfirmationOpen] = useState(false);
  const busy = navigation.state !== "idle";
  const activeIntent = String(navigation.formData?.get("intent") || "").trim();
  const creatingAgent = busy && activeIntent === "create";
  const atLimit = agents.length >= limit;
  const featureAllowed = feature?.allowed === true;
  const selectedAccessPreset = getAgentAccessPreset(createDraft.accessLevel);
  const selectedPermissionCount = AGENT_PERMISSION_OPTIONS.filter(
    ([key]) => createDraft.permissions?.[key] === true,
  ).length;
  const presetPermissions = permissionsForAccessPreset(createDraft.accessLevel);
  const permissionsCustomized = AGENT_PERMISSION_OPTIONS.some(
    ([key]) =>
      (createDraft.permissions?.[key] === true) !==
      (presetPermissions[key] === true),
  );
  const unlockHref = withShopParams(
    feature?.code === "agent_sender_not_connected"
      ? "/app/settings"
      : "/app/plans",
    location.search,
  );

  useEffect(() => {
    if (!actionData) return;
    if (actionData.ok && actionData.note) {
      shopify.toast.show(String(actionData.note));
      if (actionData.intent === "update_password") setEditingAgentId("");
      if (actionData.intent === "create") {
        setCreateConfirmationOpen(false);
        setCreateDraft(createEmptyAgentDraft());
      }
    } else if (actionData.error) {
      shopify.toast.show(String(actionData.error));
    }
  }, [actionData, shopify]);

  const reviewAgentCreation = (event) => {
    event.preventDefault();
    if (atLimit || busy) return;
    if (!event.currentTarget.checkValidity()) {
      event.currentTarget.reportValidity();
      return;
    }
    setCreateDraft((current) => ({
      ...current,
      username: current.username.trim(),
    }));
    setCreateConfirmationOpen(true);
  };

  const confirmAgentCreation = () => {
    if (atLimit || busy) return;
    const form = new FormData();
    form.set("intent", "create");
    form.set("username", createDraft.username.trim());
    form.set("accessLevel", createDraft.accessLevel);
    form.set("password", createDraft.password);
    for (const [key] of AGENT_PERMISSION_OPTIONS) {
      form.set(
        `permission_${key}`,
        createDraft.permissions?.[key] === true ? "true" : "false",
      );
    }
    submit(form, { method: "post" });
  };

  const toggleCreatePermission = (key) => {
    setCreateDraft((current) => ({
      ...current,
      permissions: {
        ...current.permissions,
        [key]: current.permissions?.[key] !== true,
      },
    }));
  };

  const resetCreatePermissions = () => {
    setCreateDraft((current) => ({
      ...current,
      permissions: permissionsForAccessPreset(current.accessLevel),
    }));
  };

  const closeCreateConfirmation = () => {
    if (!creatingAgent) setCreateConfirmationOpen(false);
  };

  return (
    <s-page heading="Agent Accounts" suppressHydrationWarning>
      <style>{styles}</style>
      <div className="agent-page">
        <section className="agent-hero">
          <div>
            <span className="agent-eyebrow">Customer support workspace</span>
            <h1>Let your team reply without sharing Meta credentials</h1>
            <p>
              Available exclusively for Your Own Number merchants with a
              connected WhatsApp sender. Create up to {limit} secure support
              logins, each isolated to this store and the active customer
              service window.
            </p>
          </div>
        </section>

        {!featureAllowed ? (
          <section className="agent-locked-panel" role="status">
            <div>
              <span className="agent-eyebrow">BYON feature</span>
              <h2>Agent Accounts are currently unavailable</h2>
              <p>
                {feature?.reason ||
                  "A connected Your Own Number plan is required."}
              </p>
              {agents.length ? (
                <small>
                  {agents.length} existing agent login
                  {agents.length === 1 ? " is" : "s are"} disabled while this
                  requirement is not met.
                </small>
              ) : null}
            </div>
            <a className="agent-primary-link" href={unlockHref}>
              {feature?.code === "agent_sender_not_connected"
                ? "Connect WhatsApp number"
                : "View Your Own Number plans"}
            </a>
          </section>
        ) : null}

        {featureAllowed ? (
          <section className="agent-login-callout">
            <div>
              <span className="agent-eyebrow">Agent sign-in page</span>
              <h2>Send agents to this page to log in</h2>
              <p>
                Agents use the username and password you create below. They do
                not need access to Shopify, Meta Business, or your WhatsApp
                credentials.
              </p>
              <code>{messengerUrl}</code>
            </div>
            <a
              className="agent-primary-link"
              href={messengerUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Go to Messenger Login
            </a>
          </section>
        ) : null}

        {actionData?.error ? (
          <s-banner tone="critical">
            <s-paragraph>{actionData.error}</s-paragraph>
          </s-banner>
        ) : null}

        {featureAllowed ? (
          <div className="agent-layout">
            <section className="agent-panel">
              <div className="agent-panel-head">
                <div>
                  <span className="agent-eyebrow">Team access</span>
                  <h2>Agent logins</h2>
                </div>
                <span className="agent-count">
                  {agents.length} / {limit}
                </span>
              </div>

              {agents.length ? (
                <div className="agent-list">
                  {agents.map((agent) => (
                    <article className="agent-card" key={agent.id}>
                      <div className="agent-avatar">
                        {String(agent.username || "A")
                          .slice(0, 1)
                          .toUpperCase()}
                      </div>
                      <div className="agent-card-copy">
                        <strong>{agent.username}</strong>
                        <span>Agent #{agent.slot}</span>
                        <small className="agent-access-badge">
                          {String(agent.accessLevel || "support").replace(
                            /^./,
                            (letter) => letter.toUpperCase(),
                          )}{" "}
                          access
                        </small>
                        {agent.lastLoginAt ? (
                          <small>
                            Last login{" "}
                            {new Date(agent.lastLoginAt).toLocaleString()}
                          </small>
                        ) : (
                          <small>Has not signed in yet</small>
                        )}
                      </div>
                      <div className="agent-card-actions">
                        <button
                          type="button"
                          className="agent-secondary"
                          onClick={() =>
                            setEditingAgentId((current) =>
                              current === agent.id ? "" : agent.id,
                            )
                          }
                        >
                          Edit password
                        </button>
                        <button
                          type="button"
                          className="agent-secondary"
                          onClick={() =>
                            setEditingAccessAgentId((current) =>
                              current === agent.id ? "" : agent.id,
                            )
                          }
                        >
                          Access levels
                        </button>
                        <Form
                          method="post"
                          onSubmit={(event) => {
                            if (
                              !window.confirm(
                                `Delete agent ${agent.username}? They will be signed out immediately.`,
                              )
                            ) {
                              event.preventDefault();
                            }
                          }}
                        >
                          <input type="hidden" name="intent" value="delete" />
                          <input
                            type="hidden"
                            name="agentId"
                            value={agent.id}
                          />
                          <button
                            type="submit"
                            className="agent-danger"
                            disabled={busy}
                          >
                            Delete
                          </button>
                        </Form>
                      </div>

                      {editingAgentId === agent.id ? (
                        <Form method="post" className="agent-password-form">
                          <input
                            type="hidden"
                            name="intent"
                            value="update_password"
                          />
                          <input
                            type="hidden"
                            name="agentId"
                            value={agent.id}
                          />
                          <label>
                            New password
                            <input
                              name="password"
                              type="password"
                              minLength={10}
                              maxLength={128}
                              autoComplete="new-password"
                              required
                              placeholder="At least 10 characters"
                            />
                          </label>
                          <button type="submit" disabled={busy}>
                            {busy ? "Updating..." : "Update password"}
                          </button>
                        </Form>
                      ) : null}
                      {editingAccessAgentId === agent.id ? (
                        <Form method="post" className="agent-access-form">
                          <input
                            type="hidden"
                            name="intent"
                            value="update_access"
                          />
                          <input
                            type="hidden"
                            name="agentId"
                            value={agent.id}
                          />
                          <label>
                            Access preset
                            <select
                              name="accessLevel"
                              defaultValue={agent.accessLevel || "support"}
                            >
                              <option value="limited">Limited</option>
                              <option value="support">Support</option>
                              <option value="manager">Manager</option>
                            </select>
                          </label>
                          <div className="agent-permission-grid">
                            {AGENT_PERMISSION_OPTIONS.map(([key, label]) => (
                              <label
                                className="agent-permission-check"
                                key={key}
                              >
                                <input
                                  type="hidden"
                                  name={`permission_${key}`}
                                  value="false"
                                />
                                <input
                                  type="checkbox"
                                  name={`permission_${key}`}
                                  value="true"
                                  defaultChecked={
                                    agent.permissions?.[key] === true
                                  }
                                />
                                <span>{label}</span>
                              </label>
                            ))}
                          </div>
                          <button type="submit" disabled={busy}>
                            {busy ? "Saving..." : "Save access"}
                          </button>
                        </Form>
                      ) : null}
                    </article>
                  ))}
                </div>
              ) : (
                <div className="agent-empty">
                  No agents yet. Create the first support login below.
                </div>
              )}
            </section>

            <aside className="agent-panel agent-create-panel">
              <div className="agent-create-head">
                <span className="agent-eyebrow">Add account</span>
                <h2>{atLimit ? "Agent limit reached" : "Create an agent"}</h2>
              </div>
              <form
                className="agent-create-form"
                onSubmit={reviewAgentCreation}
              >
                <label>
                  Username
                  <input
                    name="username"
                    value={createDraft.username}
                    onChange={(event) =>
                      setCreateDraft((current) => ({
                        ...current,
                        username: event.target.value,
                      }))
                    }
                    minLength={3}
                    maxLength={40}
                    pattern="[A-Za-z0-9._-]+"
                    autoComplete="off"
                    required
                    disabled={atLimit || busy}
                    placeholder="support.agent"
                  />
                </label>
                <label>
                  Access preset
                  <select
                    name="accessLevel"
                    value={createDraft.accessLevel}
                    onChange={(event) =>
                      setCreateDraft((current) => {
                        const accessLevel = event.target.value;
                        return {
                          ...current,
                          accessLevel,
                          permissions: permissionsForAccessPreset(accessLevel),
                        };
                      })
                    }
                    disabled={atLimit || busy}
                  >
                    <option value="limited">Limited - focused replies</option>
                    <option value="support">Support - daily support</option>
                    <option value="manager">Manager - full workspace</option>
                  </select>
                </label>
                <label>
                  Password
                  <input
                    name="password"
                    type="password"
                    value={createDraft.password}
                    onChange={(event) =>
                      setCreateDraft((current) => ({
                        ...current,
                        password: event.target.value,
                      }))
                    }
                    minLength={10}
                    maxLength={128}
                    autoComplete="new-password"
                    required
                    disabled={atLimit || busy}
                    placeholder="At least 10 characters"
                  />
                </label>
                <button
                  type="submit"
                  className="agent-primary"
                  disabled={atLimit || busy}
                >
                  {busy ? "Please wait..." : "Add Agent Account"}
                </button>
              </form>
            </aside>
          </div>
        ) : null}
      </div>

      <Modal
        id="confirm-agent-account-access"
        variant="large"
        open={createConfirmationOpen}
        onHide={closeCreateConfirmation}
      >
        <TitleBar title="Confirm agent access">
          <button
            type="button"
            onClick={closeCreateConfirmation}
            disabled={creatingAgent}
          >
            Edit details
          </button>
          <button
            type="button"
            variant="primary"
            onClick={confirmAgentCreation}
            disabled={atLimit || busy}
          >
            {creatingAgent ? "Creating agent..." : "Confirm and create"}
          </button>
        </TitleBar>

        <div className="agent-confirm-modal">
          <div className="agent-confirm-intro">
            <span className="agent-confirm-mark" aria-hidden="true">
              AC
            </span>
            <div>
              <span className="agent-eyebrow">Final access review</span>
              <h2>Approve this team login</h2>
              <p>
                Review exactly what this agent can access before the account is
                created for your store.
              </p>
            </div>
          </div>

          <div className="agent-confirm-identity">
            <div>
              <span>Username</span>
              <strong>{createDraft.username.trim()}</strong>
            </div>
            <div>
              <span>Access preset</span>
              <strong>{selectedAccessPreset.label}</strong>
              <small>
                {permissionsCustomized
                  ? "Customized permissions"
                  : selectedAccessPreset.shortLabel}
              </small>
            </div>
          </div>

          <div className="agent-confirm-preset-copy">
            <span className="agent-confirm-preset-badge">
              {selectedAccessPreset.label} preset
            </span>
            <p>
              {selectedAccessPreset.description} Use the controls below to
              tailor this agent without changing the preset for anyone else.
            </p>
          </div>

          <section className="agent-confirm-permissions">
            <div className="agent-confirm-permissions-head">
              <div>
                <span className="agent-eyebrow">Permission controls</span>
                <h3>Customize agent access</h3>
                <small>
                  {selectedPermissionCount} of {AGENT_PERMISSION_OPTIONS.length}{" "}
                  permissions enabled
                  {permissionsCustomized
                    ? " - customized"
                    : " - preset defaults"}
                </small>
              </div>
              <button
                type="button"
                className="agent-reset-permissions"
                onClick={resetCreatePermissions}
                disabled={!permissionsCustomized || creatingAgent}
              >
                Reset to {selectedAccessPreset.label}
              </button>
            </div>

            <div className="agent-confirm-permission-grid">
              {AGENT_PERMISSION_OPTIONS.map(([key, label]) => {
                const enabled = createDraft.permissions?.[key] === true;
                return (
                  <label
                    className={`agent-confirm-permission-toggle${
                      enabled ? " enabled" : ""
                    }`}
                    key={key}
                  >
                    <span className="agent-confirm-permission-copy">
                      <strong>{label}</strong>
                      <small>{AGENT_PERMISSION_DESCRIPTIONS[key]}</small>
                    </span>
                    <span className="agent-toggle-control">
                      <input
                        type="checkbox"
                        role="switch"
                        checked={enabled}
                        disabled={creatingAgent}
                        onChange={() => toggleCreatePermission(key)}
                        aria-label={`${enabled ? "Disable" : "Enable"} ${label}`}
                      />
                      <span aria-hidden="true" />
                    </span>
                  </label>
                );
              })}
            </div>
          </section>

          <div className="agent-confirm-safety">
            <strong>Protected by OrderX</strong>
            <span>
              The password is securely hashed, Meta credentials are never
              shared, and WhatsApp reply-window rules remain enforced by the
              server for every agent action.
            </span>
          </div>

          {actionData?.intent === "create" && actionData?.error ? (
            <div className="agent-confirm-error" role="alert">
              {actionData.error}
            </div>
          ) : null}
        </div>
      </Modal>
    </s-page>
  );
}

const styles = `
.agent-page { display: grid; gap: 18px; padding: 18px; max-width: 1320px; margin: 0 auto; color: #17211d; }
.agent-hero, .agent-panel, .agent-login-callout { border: 1px solid #d9e4de; border-radius: 24px; background: #fff; box-shadow: 0 16px 42px rgba(22, 46, 35, .08); }
.agent-locked-panel { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 24px; border: 1px solid #efcf83; border-radius: 22px; background: linear-gradient(135deg, #fff8e7, #fffdf8); }
.agent-locked-panel h2 { margin: 5px 0 8px; }
.agent-locked-panel p { max-width: 760px; margin: 0; color: #665e4d; line-height: 1.5; }
.agent-locked-panel small { display: block; margin-top: 10px; color: #8a7250; }
.agent-hero { display: flex; justify-content: space-between; align-items: center; gap: 24px; padding: 30px; background: radial-gradient(circle at 90% 10%, rgba(241, 180, 74, .2), transparent 30%), linear-gradient(135deg, #eaf7f0, #f9fbf7 58%, #fff8eb); }
.agent-hero h1 { max-width: 760px; margin: 6px 0 10px; font-family: Georgia, "Times New Roman", serif; font-size: clamp(30px, 4vw, 46px); line-height: 1.03; letter-spacing: -.025em; }
.agent-hero p { max-width: 760px; margin: 0; color: #5d6b64; line-height: 1.55; }
.agent-login-callout { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 22px 24px; border-color: #b9dfcf; background: linear-gradient(135deg, #f3fbf6, #fffdf5); }
.agent-login-callout h2 { margin: 5px 0 7px; font-size: 23px; }
.agent-login-callout p { max-width: 760px; margin: 0; color: #5d6b64; line-height: 1.5; }
.agent-login-callout code { display: block; width: fit-content; max-width: 100%; margin-top: 11px; padding: 7px 10px; border: 1px solid #d8e5de; border-radius: 9px; background: #fff; color: #355249; overflow-wrap: anywhere; white-space: normal; }
.agent-eyebrow { color: #08745a; font-size: 12px; font-weight: 900; letter-spacing: .14em; text-transform: uppercase; }
.agent-primary-link, .agent-primary { border: 1px solid #075e54; border-radius: 13px; background: #075e54; color: #fff; padding: 12px 17px; font-weight: 850; text-decoration: none; text-align: center; white-space: nowrap; }
.agent-layout { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(310px, .65fr); gap: 18px; align-items: start; }
.agent-panel { padding: 22px; }
.agent-panel h2 { margin: 5px 0 0; font-size: 25px; }
.agent-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.agent-count { border-radius: 999px; background: #e8f7ef; color: #08745a; padding: 8px 13px; font-weight: 900; }
.agent-list { display: grid; gap: 12px; }
.agent-card { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 14px; align-items: center; border: 1px solid #e3ebe6; border-radius: 18px; padding: 15px; background: linear-gradient(180deg, #fff, #fbfdfb); }
.agent-avatar { width: 46px; height: 46px; display: grid; place-items: center; border-radius: 15px; background: #d7f4e5; color: #075e54; font-size: 20px; font-weight: 950; }
.agent-card-copy strong, .agent-card-copy span, .agent-card-copy small { display: block; }
.agent-card-copy span { margin-top: 3px; color: #68766f; }
.agent-card-copy small { margin-top: 5px; color: #8b9690; }
.agent-card-actions { display: flex; gap: 8px; }
.agent-card button, .agent-create-form button, .agent-password-form button, .agent-access-form button { border: 1px solid #cdd9d2; border-radius: 11px; background: #fff; padding: 10px 13px; font-weight: 850; cursor: pointer; }
.agent-card button:disabled, .agent-create-form button:disabled { opacity: .5; cursor: not-allowed; }
.agent-danger { color: #b42318; border-color: #fecaca !important; }
.agent-password-form { grid-column: 2 / -1; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: end; padding-top: 12px; border-top: 1px solid #edf1ee; }
.agent-access-form { grid-column: 1 / -1; display: grid; gap: 13px; padding-top: 14px; border-top: 1px solid #edf1ee; }
.agent-access-form > label, .agent-create-form > label { color: #34443c; font-weight: 800; }
.agent-access-form select, .agent-create-form select { width: 100%; box-sizing: border-box; margin-top: 7px; border: 1px solid #c8d5ce; border-radius: 12px; padding: 11px 12px; background: #fff; font: inherit; }
.agent-permission-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
.agent-permission-check { display: flex !important; align-items: flex-start; gap: 9px; border: 1px solid #e1e9e4; border-radius: 12px; padding: 10px; background: #f9fbfa; color: #45564e !important; font-size: 13px; line-height: 1.35; }
.agent-permission-check input[type="checkbox"] { width: auto; margin: 2px 0 0; flex: 0 0 auto; }
.agent-access-badge { color: #08745a !important; font-weight: 800; }
.agent-create-panel { position: sticky; top: 18px; overflow: hidden; border-color: #cfe0d7; background: radial-gradient(circle at 100% 0, rgba(241, 180, 74, .16), transparent 36%), linear-gradient(180deg, #ffffff, #f8fcf9); }
.agent-create-panel::before { content: ""; display: block; height: 4px; margin: -22px -22px 20px; background: linear-gradient(90deg, #075e54, #19a77e 58%, #e8b454); }
.agent-create-head { padding-bottom: 17px; border-bottom: 1px solid #e5ece8; }
.agent-create-head h2 { margin-top: 7px; }
.agent-create-form { display: grid; gap: 17px; margin-top: 19px; }
.agent-create-form label, .agent-password-form label { color: #34443c; font-weight: 800; }
.agent-create-form input, .agent-password-form input { width: 100%; box-sizing: border-box; margin-top: 7px; border: 1px solid #c8d5ce; border-radius: 12px; padding: 12px 13px; background: rgba(255, 255, 255, .94); font: inherit; color: #17211d; transition: border-color .16s ease, box-shadow .16s ease, background .16s ease; }
.agent-create-form select { padding: 12px 13px; color: #17211d; transition: border-color .16s ease, box-shadow .16s ease; }
.agent-create-form input:hover, .agent-create-form select:hover { border-color: #9bbbad; }
.agent-create-form input:focus, .agent-create-form select:focus { outline: none; border-color: #08745a; box-shadow: 0 0 0 3px rgba(8, 116, 90, .12); background: #fff; }
.agent-create-form .agent-primary { width: 100%; min-height: 46px; margin-top: 2px; background: linear-gradient(135deg, #075e54, #08745a); border-color: #075e54; box-shadow: 0 10px 22px rgba(7, 94, 84, .18); transition: transform .16s ease, box-shadow .16s ease, filter .16s ease; }
.agent-create-form .agent-primary:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 13px 26px rgba(7, 94, 84, .24); filter: brightness(1.03); }
.agent-confirm-modal { display: grid; gap: 18px; padding: 24px; color: #17211d; background: radial-gradient(circle at 94% 2%, rgba(239, 185, 84, .16), transparent 30%), linear-gradient(180deg, #fbfefc, #f5f9f7); font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.agent-confirm-intro { display: flex; align-items: center; gap: 15px; }
.agent-confirm-mark { width: 54px; height: 54px; flex: 0 0 auto; display: grid; place-items: center; border-radius: 18px; background: linear-gradient(145deg, #075e54, #0d8b6d); color: #fff; font-size: 15px; font-weight: 950; letter-spacing: .06em; box-shadow: 0 12px 25px rgba(7, 94, 84, .2); }
.agent-confirm-intro h2 { margin: 5px 0 4px; font-size: 25px; line-height: 1.15; }
.agent-confirm-intro p { margin: 0; color: #637169; line-height: 1.45; }
.agent-confirm-identity { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 11px; }
.agent-confirm-identity > div { min-width: 0; padding: 14px 15px; border: 1px solid #dce7e1; border-radius: 15px; background: rgba(255, 255, 255, .9); box-shadow: 0 7px 18px rgba(25, 49, 38, .045); }
.agent-confirm-identity span, .agent-confirm-identity strong, .agent-confirm-identity small { display: block; }
.agent-confirm-identity span { color: #76837c; font-size: 12px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; }
.agent-confirm-identity strong { margin-top: 5px; overflow-wrap: anywhere; font-size: 17px; }
.agent-confirm-identity small { margin-top: 3px; color: #08745a; font-weight: 750; }
.agent-confirm-preset-copy { display: flex; align-items: center; gap: 12px; padding: 14px 15px; border: 1px solid #bde0d1; border-radius: 15px; background: linear-gradient(135deg, #effaf4, #fffdf7); }
.agent-confirm-preset-copy p { margin: 0; color: #52635a; line-height: 1.45; }
.agent-confirm-preset-badge { flex: 0 0 auto; border-radius: 999px; padding: 7px 10px; background: #d8f3e5; color: #075e54; font-size: 12px; font-weight: 900; white-space: nowrap; }
.agent-confirm-permissions { overflow: hidden; border: 1px solid #d7e4dd; border-radius: 18px; background: rgba(255, 255, 255, .94); box-shadow: 0 9px 24px rgba(25, 49, 38, .05); }
.agent-confirm-permissions-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 17px; border-bottom: 1px solid #e3ebe7; background: linear-gradient(135deg, #fbfefc, #f4faf7); }
.agent-confirm-permissions-head h3 { margin: 4px 0 3px; font-size: 17px; }
.agent-confirm-permissions-head small { display: block; color: #6f7d76; line-height: 1.4; }
.agent-reset-permissions { flex: 0 0 auto; border: 1px solid #b9cec4; border-radius: 11px; padding: 9px 12px; background: #fff; color: #075e54; font: inherit; font-size: 13px; font-weight: 850; cursor: pointer; transition: border-color .16s ease, background .16s ease, opacity .16s ease; }
.agent-reset-permissions:hover:not(:disabled) { border-color: #75aa96; background: #f1faf5; }
.agent-reset-permissions:disabled { opacity: .42; cursor: not-allowed; }
.agent-confirm-permission-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px;  padding: 12px;   }
.agent-confirm-permission-toggle { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; padding: 13px 14px; border: 1px solid #e0e8e4; border-radius: 14px; background: #f9fbfa; cursor: pointer; transition: border-color .16s ease, background .16s ease, box-shadow .16s ease, transform .16s ease; }
.agent-confirm-permission-toggle:hover { border-color: #b7ccc2; background: #fff; transform: translateY(-1px); }
.agent-confirm-permission-toggle.enabled { border-color: #a9d8c5; background: linear-gradient(135deg, #f0fbf5, #fbfefc); box-shadow: inset 3px 0 0 #15966f; }
.agent-confirm-permission-copy { min-width: 0; }
.agent-confirm-permission-copy strong, .agent-confirm-permission-copy small { display: block; }
.agent-confirm-permission-copy strong { color: #26362e; font-size: 13px; line-height: 1.35; }
.agent-confirm-permission-copy small { margin-top: 4px; color: #748079; font-size: 12px; line-height: 1.35; }
.agent-toggle-control { position: relative; width: 42px; height: 24px; flex: 0 0 42px; }
.agent-toggle-control input { position: absolute; inset: 0; z-index: 2; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
.agent-toggle-control > span { position: absolute; inset: 0; border-radius: 999px; background: #b7c1bc; box-shadow: inset 0 0 0 1px rgba(32, 49, 41, .08); transition: background .18s ease, box-shadow .18s ease; }
.agent-toggle-control > span::after { content: ""; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 999px; background: #fff; box-shadow: 0 2px 5px rgba(21, 39, 30, .22); transition: transform .18s ease; }
.agent-toggle-control input:checked + span { background: #08745a; box-shadow: inset 0 0 0 1px rgba(4, 77, 59, .15), 0 0 0 3px rgba(8, 116, 90, .08); }
.agent-toggle-control input:checked + span::after { transform: translateX(18px); }
.agent-toggle-control input:focus-visible + span { outline: 3px solid rgba(44, 126, 99, .25); outline-offset: 2px; }
.agent-toggle-control input:disabled { cursor: not-allowed; }
.agent-toggle-control input:disabled + span { opacity: .58; }
.agent-confirm-safety { display: grid; gap: 4px; padding: 15px 17px; border: 1px solid #efd493; border-radius: 16px; background: linear-gradient(135deg, #fff9e8, #fffcf4); }
.agent-confirm-safety strong { color: #51472f; }
.agent-confirm-safety span { color: #72674d; line-height: 1.45; }
.agent-confirm-error { padding: 13px 15px; border: 1px solid #f3b8b2; border-radius: 14px; background: #fff2f0; color: #a1251b; font-weight: 750; line-height: 1.4; }
.agent-empty { border: 1px dashed #bfcdc5; border-radius: 17px; padding: 30px; text-align: center; color: #6b7972; background: #f9fbfa; }
@media (max-width: 850px) {
  .agent-hero, .agent-login-callout, .agent-locked-panel { align-items: stretch; flex-direction: column; }
  .agent-layout { grid-template-columns: 1fr; }
  .agent-card { grid-template-columns: auto minmax(0, 1fr); }
  .agent-card-actions, .agent-password-form { grid-column: 1 / -1; }
  .agent-card-actions { flex-wrap: wrap; }
  .agent-password-form { grid-template-columns: 1fr; }
  .agent-permission-grid { grid-template-columns: 1fr; }
  .agent-primary-link { white-space: normal; }
  .agent-create-panel { position: static; }
  .agent-confirm-permission-grid { grid-template-columns: 1fr;  }
}
@media (max-width: 560px) {
  .agent-confirm-modal { gap: 14px; padding: 18px; }
  .agent-confirm-intro { align-items: flex-start; }
  .agent-confirm-mark { width: 46px; height: 46px; border-radius: 15px; }
  .agent-confirm-intro h2 { font-size: 21px; }
  .agent-confirm-identity { grid-template-columns: 1fr; }
  .agent-confirm-preset-copy { align-items: flex-start; flex-direction: column; }
  .agent-confirm-permissions-head { align-items: stretch; flex-direction: column; }
  .agent-reset-permissions { width: 100%; }
  .agent-confirm-permission-grid { padding: 9px; }
}
`;

export const headers = (headersArgs) => boundary.headers(headersArgs);
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
