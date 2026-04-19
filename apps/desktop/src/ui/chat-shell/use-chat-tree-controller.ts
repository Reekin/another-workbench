import { useEffect, useState, type RefObject } from "react";
import type { ChatTreeSnapshotRpc } from "@another-workbench/shared";
import type { DesktopTransport } from "../../transport/desktop-transport.js";
import type { ComposerStatusNotice } from "./composer-status.js";

type StatusNoticeSetter = (
  notice: ComposerStatusNotice | undefined
) => void;

export const useChatTreeController = (input: {
  transport?: DesktopTransport;
  browsedSessionId?: string;
  displayedSessionId?: string;
  displayedSessionIdRef: RefObject<string | undefined>;
  isOpeningSelectedSession: boolean;
  eventCursor?: string;
  releasedSessionId?: string;
  onStatusNotice: StatusNoticeSetter;
  reloadSessionWindow: (sessionId: string) => Promise<void>;
}): {
  chatTree: ChatTreeSnapshotRpc | undefined;
  setChatTree: (next: ChatTreeSnapshotRpc | undefined) => void;
  onJumpChatTree: (nodeId: string) => Promise<void>;
} => {
  const [chatTree, setChatTree] = useState<ChatTreeSnapshotRpc | undefined>();

  useEffect(() => {
    if (!input.releasedSessionId) {
      return;
    }
    setChatTree((current) =>
      current?.sessionId === input.releasedSessionId ? undefined : current
    );
  }, [input.releasedSessionId]);

  useEffect(() => {
    if (!input.transport || !input.browsedSessionId) {
      setChatTree(undefined);
      return;
    }
    let disposed = false;
    void input.transport.chatTree
      .get(input.browsedSessionId)
      .then((nextTree) => {
        if (!disposed && input.displayedSessionIdRef.current === input.browsedSessionId) {
          setChatTree(nextTree);
        }
      })
      .catch((error) => {
        if (!disposed && input.displayedSessionIdRef.current === input.browsedSessionId) {
          input.onStatusNotice({
            message: `Chat tree refresh failed: ${(error as Error).message}`,
            source: "chat-tree"
          });
        }
      });
    return () => {
      disposed = true;
    };
  }, [input.transport, input.browsedSessionId, input.eventCursor]);

  return {
    chatTree,
    setChatTree,
    onJumpChatTree: async (nodeId: string): Promise<void> => {
      if (!input.transport || !input.displayedSessionId || input.isOpeningSelectedSession) {
        return;
      }
      try {
        await input.transport.chatTree.jump({
          sessionId: input.displayedSessionId,
          nodeId
        });
        const nextTree = await input.transport.chatTree.get(input.displayedSessionId);
        setChatTree(nextTree);
        const currentNode =
          nextTree.nodes.find((node) => node.nodeId === nextTree.currentNodeId) ??
          nextTree.nodes.find((node) => node.nodeId === nodeId);
        if (currentNode?.turnId) {
          await input.reloadSessionWindow(input.displayedSessionId);
        }
        input.onStatusNotice({
          message: `Jumped to ${nodeId}`,
          source: "chat-tree"
        });
      } catch (error) {
        input.onStatusNotice({
          message: `Chat tree jump failed: ${(error as Error).message}`,
          persistent: true,
          source: "chat-tree"
        });
      }
    }
  };
};
