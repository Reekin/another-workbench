import { useEffect, type ReactElement } from "react";
import { createPortal } from "react-dom";

export type ImageLightboxState = {
  src: string;
  alt: string;
};

export type ImageLightboxProps = {
  image?: ImageLightboxState;
  onClose: () => void;
};

export const ImageLightbox = ({
  image,
  onClose
}: ImageLightboxProps): ReactElement | null => {
  useEffect(() => {
    if (!image) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [image, onClose]);

  if (!image) {
    return null;
  }

  const markup = (
    <div
      className="awb-lightbox"
      role="presentation"
      onClick={onClose}
    >
      <section
        className="awb-lightbox__dialog"
        role="dialog"
        aria-modal="true"
        aria-label={image.alt}
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="awb-lightbox__close"
          onClick={onClose}
          aria-label="Close image preview"
        >
          Close
        </button>
        <img className="awb-lightbox__image" src={image.src} alt={image.alt} />
      </section>
    </div>
  );

  return typeof document === "undefined"
    ? markup
    : createPortal(markup, document.body);
};
