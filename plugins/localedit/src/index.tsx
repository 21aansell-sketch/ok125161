import { findByProps, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher, i18n } from "@vendetta/metro/common";
import { after, before } from "@vendetta/patcher";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { Forms } from "@vendetta/ui/components";
import { findInReactTree } from "@vendetta/utils";

type Message = {
    id: string;
    channel_id: string;
    content?: string;
    author?: {
        id: string;
        [key: string]: any;
    };
    [key: string]: any;
};

type Patch = () => void;

/*
 * Discord changes its internal module exports fairly frequently.
 * Keep discovery property-based rather than depending on numeric module IDs
 * or a particular Discord build.
 */

const LazyActionSheet =
    findByProps("openLazy", "hideActionSheet") ??
    findByProps("openLazy");

const ActionSheetModule =
    findByProps("ActionSheetRow") ??
    findByProps("FormRow");

const ActionSheetRow =
    ActionSheetModule?.ActionSheetRow ??
    Forms?.FormRow;

const MessageStore = findByStoreName("MessageStore");
const UserStore = findByStoreName("UserStore");

/*
 * Newer Discord builds have changed the exact set of exports exposed by
 * their message-actions module. Try several property combinations.
 */
const Messages =
    findByProps("sendMessage", "startEditMessage", "editMessage") ??
    findByProps("startEditMessage", "editMessage") ??
    findByProps("editMessage", "endEditMessage");

const edits = new Map<string, Message>();

let isEditing = false;
let editingMessageId: string | null = null;

let patches: Patch[] = [];

/**
 * Diagnostic logging.
 *
 * This makes it possible to distinguish:
 * 1. Manifest/plugin never loaded
 * 2. Plugin loaded but an API is missing
 * 3. Plugin loaded successfully but the action-sheet patch isn't firing
 */
function logDiagnostics(): void {
    console.log("[LocalEdit] API discovery:", {
        LazyActionSheet: !!LazyActionSheet,
        openLazy: !!LazyActionSheet?.openLazy,
        hideActionSheet: !!LazyActionSheet?.hideActionSheet,

        ActionSheetModule: !!ActionSheetModule,
        ActionSheetRow: !!ActionSheetRow,

        MessageStore: !!MessageStore,
        getMessage: !!MessageStore?.getMessage,

        UserStore: !!UserStore,
        getCurrentUser: !!UserStore?.getCurrentUser,

        Messages: !!Messages,
        startEditMessage: !!Messages?.startEditMessage,
        editMessage: !!Messages?.editMessage,
        endEditMessage: !!Messages?.endEditMessage,
    });
}

function getCurrentUser(): any {
    try {
        return UserStore?.getCurrentUser?.();
    } catch (error) {
        console.warn("[LocalEdit] Failed to get current user:", error);
        return null;
    }
}

function getMessage(channelId: string, messageId: string): Message | null {
    try {
        return MessageStore?.getMessage?.(channelId, messageId) ?? null;
    } catch (error) {
        console.warn("[LocalEdit] Failed to get message:", error);
        return null;
    }
}

function cloneMessage(message: Message): Message {
    /*
     * Discord message objects are generally serialisable along this path.
     * structuredClone is preferable when available.
     */
    try {
        if (typeof structuredClone === "function")
            return structuredClone(message);

        return JSON.parse(JSON.stringify(message));
    } catch {
        return { ...message };
    }
}

function getActionSheetRows(tree: any): any[] | null {
    /*
     * Discord can wrap the action-sheet rows differently between builds.
     * Don't depend exclusively on a particular React component name.
     */
    return findInReactTree(tree, (node: any) => {
        if (!Array.isArray(node) || !node.length)
            return false;

        return node.some((child: any) => {
            const typeName =
                child?.type?.name ??
                child?.type?.displayName ??
                child?.type?.render?.name;

            return (
                typeName === "ActionSheetRow" ||
                typeName === "FormRow" ||
                child?.props?.label != null
            );
        });
    });
}

function getRowLabel(row: any): string | undefined {
    return (
        row?.props?.label ??
        row?.props?.children?.props?.label ??
        row?.props?.children?.label
    );
}

function hasLocalEditButton(rows: any[]): boolean {
    return rows.some((row) => getRowLabel(row) === "Edit Locally");
}

function findInsertPosition(rows: any[]): number {
    const markUnread = i18n?.Messages?.MARK_UNREAD;

    if (!markUnread)
        return 0;

    const index = rows.findIndex(
        (row) =>
            row?.props?.message === markUnread ||
            row?.props?.label === markUnread
    );

    return index >= 0 ? index : 0;
}

function beginLocalEdit(message: Message): void {
    if (!Messages?.startEditMessage) {
        console.warn("[LocalEdit] startEditMessage API not found");
        return;
    }

    console.log("[LocalEdit] Beginning local edit:", message.id);

    isEditing = true;
    editingMessageId = message.id;

    if (!edits.has(message.id))
        edits.set(message.id, cloneMessage(message));

    try {
        LazyActionSheet?.hideActionSheet?.();
    } catch {
        // Discord changed the action-sheet implementation.
    }

    /*
     * This invokes Discord's native edit composer.
     *
     * The editMessage patch below prevents the resulting edit from
     * reaching Discord's remote API.
     */
    try {
        Messages.startEditMessage(
            message.channel_id,
            message.id,
            message.content ?? ""
        );
    } catch (error) {
        console.error("[LocalEdit] startEditMessage failed:", error);

        isEditing = false;
        editingMessageId = null;
    }
}

export default {
    onLoad() {
        /*
         * IMPORTANT:
         * If this message appears in the console, the manifest successfully
         * loaded the plugin and execution reached index.tsx.
         */
        console.log("[LocalEdit] onLoad reached");

        logDiagnostics();

        /*
         * Guard against a partially incompatible Discord build.
         */
        if (!LazyActionSheet?.openLazy) {
            console.warn("[LocalEdit] ActionSheet API not found");
            return;
        }

        if (!MessageStore?.getMessage) {
            console.warn("[LocalEdit] MessageStore API not found");
            return;
        }

        if (!UserStore?.getCurrentUser) {
            console.warn("[LocalEdit] UserStore API not found");
            return;
        }

        if (!ActionSheetRow) {
            console.warn("[LocalEdit] ActionSheetRow/FormRow not found");
            return;
        }

        console.log("[LocalEdit] Required APIs found");

        /*
         * Add "Edit Locally" to the message long-press action sheet.
         */
        patches.push(
            before(
                "openLazy",
                LazyActionSheet,
                (args: any[]) => {
                    /*
                     * Log the arguments so we can see whether Discord changed
                     * the openLazy signature.
                     */
                    console.log("[LocalEdit] openLazy called:", args);

                    const [component, key, msg] = args;

                    if (key !== "MessageLongPressActionSheet") {
                        return;
                    }

                    console.log(
                        "[LocalEdit] MessageLongPressActionSheet detected"
                    );

                    const originalMessage: Message | undefined =
                        msg?.message;

                    if (!originalMessage) {
                        console.warn(
                            "[LocalEdit] No message found in action-sheet args"
                        );
                        return;
                    }

                    /*
                     * Discord loads this action sheet lazily.
                     */
                    if (!component?.then) {
                        console.warn(
                            "[LocalEdit] Action-sheet component is not a Promise"
                        );
                        return;
                    }

                    component.then((instance: any) => {
                        if (!instance) {
                            console.warn(
                                "[LocalEdit] Lazy action-sheet resolved to nothing"
                            );
                            return;
                        }

                        let unpatch: Patch | undefined;

                        try {
                            unpatch = after(
                                "default",
                                instance,
                                (_args: any[], result: any) => {
                                    /*
                                     * Only patch this particular render.
                                     */
                                    setTimeout(() => {
                                        try {
                                            unpatch?.();
                                        } catch {
                                            // Already removed.
                                        }
                                    }, 0);

                                    const rows = getActionSheetRows(result);

                                    if (!rows) {
                                        console.warn(
                                            "[LocalEdit] Could not find action-sheet rows"
                                        );
                                        return;
                                    }

                                    console.log(
                                        "[LocalEdit] Found action-sheet rows:",
                                        rows.length
                                    );

                                    const currentUser = getCurrentUser();

                                    if (!currentUser?.id) {
                                        console.warn(
                                            "[LocalEdit] Could not determine current user"
                                        );
                                        return;
                                    }

                                    const currentMessage =
                                        getMessage(
                                            originalMessage.channel_id,
                                            originalMessage.id
                                        ) ?? originalMessage;

                                    /*
                                     * Preserve the original behavior:
                                     * users cannot locally edit their own messages
                                     * through this menu item.
                                     */
                                    if (
                                        currentMessage.author?.id ===
                                        currentUser.id
                                    ) {
                                        console.log(
                                            "[LocalEdit] Message belongs to current user; skipping"
                                        );
                                        return;
                                    }

                                    if (hasLocalEditButton(rows)) {
                                        return;
                                    }

                                    const position =
                                        findInsertPosition(rows);

                                    console.log(
                                        "[LocalEdit] Inserting Edit Locally at:",
                                        position
                                    );

                                    rows.splice(
                                        position,
                                        0,
                                        <ActionSheetRow
                                            label="Edit Locally"
                                            icon={
                                                ActionSheetRow?.Icon ? (
                                                    <ActionSheetRow.Icon
                                                        source={getAssetIDByName(
                                                            "ic_edit_24px"
                                                        )}
                                                    />
                                                ) : undefined
                                            }
                                            onPress={() =>
                                                beginLocalEdit(
                                                    currentMessage
                                                )
                                            }
                                        />
                                    );
                                }
                            );
                        } catch (error) {
                            console.error(
                                "[LocalEdit] Failed to patch action-sheet render:",
                                error
                            );
                        }
                    });
                }
            )
        );

        /*
         * Intercept Discord's normal edit operation.
         *
         * The composer is still Discord's own composer, but when the user
         * confirms an edit while Local Edit is active, dispatch a local
         * MESSAGE_UPDATE instead of allowing the remote edit operation.
         */
        if (Messages?.editMessage) {
            patches.push(
                before(
                    "editMessage",
                    Messages,
                    (args: any[]) => {
                        const [channelId, messageId, message] = args;

                        if (!isEditing)
                            return;

                        if (
                            !editingMessageId ||
                            messageId !== editingMessageId
                        ) {
                            return;
                        }

                        const baseMessage = edits.get(messageId);

                        if (!baseMessage)
                            return;

                        console.log(
                            "[LocalEdit] Intercepting edit:",
                            messageId
                        );

                        FluxDispatcher.dispatch({
                            type: "MESSAGE_UPDATE",
                            message: {
                                ...baseMessage,
                                channel_id: channelId,
                                content:
                                    typeof message === "string"
                                        ? message
                                        : message?.content ??
                                          baseMessage.content ??
                                          "",
                                /*
                                 * A local edit should not display Discord's
                                 * normal remote-edited state.
                                 */
                                edited_timestamp: null,
                            },
                            otherPluginBypass: true,
                        });

                        /*
                         * Returning false prevents the original editMessage
                         * call from executing.
                         */
                        return false;
                    }
                )
            );
        } else {
            console.warn(
                "[LocalEdit] editMessage API not found; remote edits will NOT be intercepted"
            );
        }

        /*
         * Discord calls endEditMessage when the edit composer closes.
         * Reset our interception state here.
         */
        if (Messages?.endEditMessage) {
            patches.push(
                after("endEditMessage", Messages, () => {
                    if (!isEditing)
                        return;

                    console.log("[LocalEdit] Edit composer closed");

                    isEditing = false;
                    editingMessageId = null;
                })
            );
        } else {
            console.warn(
                "[LocalEdit] endEditMessage API not found"
            );
        }

        console.log(
            "[LocalEdit] Loaded successfully. Patches:",
            patches.length
        );
    },

    onUnload() {
        console.log("[LocalEdit] Unloading");

        for (const patch of patches) {
            try {
                patch();
            } catch {
                // Ignore already-removed patches.
            }
        }

        patches = [];

        edits.clear();

        isEditing = false;
        editingMessageId = null;

        console.log("[LocalEdit] Unloaded");
    },
};
