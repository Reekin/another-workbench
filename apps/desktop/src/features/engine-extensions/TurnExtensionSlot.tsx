import type { ReactNode, ReactElement } from "react";

export type TurnExtensionSlotProps = {
  extensionKey: string;
  children?: ReactNode;
};

export const TurnExtensionSlot = ({
  extensionKey,
  children
}: TurnExtensionSlotProps): ReactElement | null => {
  if (!children) {
    return null;
  }

  return (
    <section
      className="awb-turn-extension-slot"
      data-extension-key={extensionKey}
      aria-label={`${extensionKey} extension`}
    >
      {children}
    </section>
  );
};
