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
 *
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
    Forms.FormRow;

const MessageStore = findByStoreName("MessageStore");
const UserStore = findByStoreName("UserStore");

/*
 * Newer Discord builds have changed the exact set of exports exposed by
 * their message-actions module. Try the complete set first, then progressively
 * weaker property matches.
 */
const Messages =
    findByProps("sendMessage", "startEditMessage", "editMessage") ??
    findByProps("startEditMessage", "editMessage") ??
    findByProps("editMessage", "endEditMessage");

const edits = new Map<string, Message>();

let isEditing = false;
let editingMessageId: string | null = null;

let patches: Patch[] = [];

function getCurrentUser(): any {
    try {
        return UserStore?.getCurrentUser?.();
    } catch {
        return null;
    }
}

function getMessage(channelId: string, messageId: string): Message | null {
    try {
        return MessageStore?.getMessage?.(channelId, messageId) ?? null;
    } catch {
        return null;
    }
}

function cloneMessage(message: Message): Message {
    /*
     * Discord message objects are plain serialisable objects in the relevant
     * store path. structuredClone is preferable when available, but retain
     * JSON as a compatibility fallback.
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
     * The old implementation depended on:
     *
     *   x?.[0]?.type?.name === "ActionSheetRow"
     *
     * That is unnecessarily strict and can break when Discord wraps the
     * component differently.
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
    if (!Messages?.startEditMessage)
        return;

    isEditing = true;
    editingMessageId = message.id;

    if (!edits.has(message.id))
        edits.set(message.id, cloneMessage(message));

    try {
        LazyActionSheet?.hideActionSheet?.();
    } catch {
        // Discord changed the action-sheet implementation; continue anyway.
    }

    /*
     * This invokes Discord's native edit composer. The editMessage patch below
     * prevents the resulting edit from reaching Discord's remote API.
     */
    Messages.startEditMessage(
        message.channel_id,
        message.id,
        message.content ?? ""
    );
}

export default {
    onLoad() {
        /*
         * Guard against a partially incompatible Discord build. The plugin
         * should fail gracefully rather than preventing Revenge from loading
         * other plugins.
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

        /*
         * Add "Edit Locally" to the message long-press action sheet.
         */
        patches.push(
            before(
                "openLazy",
                LazyActionSheet,
                ([component, key, msg]: any[]) => {
                    if (key !== "MessageLongPressActionSheet")
                        return;

                    const originalMessage: Message | undefined =
                        msg?.message;

                    if (!originalMessage)
                        return;

                    /*
                     * Discord loads this action sheet lazily. Patch the
                     * resulting component rather than relying on its module
                     * internals.
                     */
                    if (!component?.then)
                        return;

                    component.then((instance: any) => {
                        if (!instance)
                            return;

                        let unpatch: Patch | undefined;

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

                                if (!rows)
                                    return;

                                const currentUser = getCurrentUser();

                                if (!currentUser?.id)
                                    return;

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
                                    return;
                                }

                                if (hasLocalEditButton(rows))
                                    return;

                                const position = findInsertPosition(rows);

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
                                            beginLocalEdit(currentMessage)
                                        }
                                    />
                                );
                            }
                        );
                    });
                }
            )
        );

        /*
         * Intercept Discord's normal edit operation.
         *
         * The composer is still Discord's own composer, but when the user
         * confirms an edit while Local Edit is active, we dispatch a local
         * MESSAGE_UPDATE instead of allowing the remote edit operation.
         */
        if (Messages?.editMessage) {
            patches.push(
                before("editMessage", Messages, (args: any[]) => {
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
                     * Returning false prevents the original editMessage call
                     * from executing.
                     */
                    return false;
                })
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

                    isEditing = false;
                    editingMessageId = null;
                })
            );
        }

        console.log("[LocalEdit] Loaded");
    },

    onUnload() {
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
    },
};
