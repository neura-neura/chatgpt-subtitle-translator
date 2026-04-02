import { useId } from "react";
import { Button } from "@nextui-org/react";

export const FileUploadButton = ({ label, onFileSelect, onFilesSelect, accept, inputId, buttonProps, multiple = false }) => {
  const generatedId = useId()
  const fileInputId = inputId ?? `file-input-${generatedId.replace(/:/g, "")}`

  const handleFileInput = (e) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) {
      onFilesSelect?.(files);
      if (!onFilesSelect) {
        onFileSelect?.(files[0]);
      }
    }
    e.target.value = "";
  };

  return (
    <div>
      <input
        type="file"
        id={fileInputId}
        style={{ display: 'none' }}
        onChange={handleFileInput}
        accept={accept}
        multiple={multiple}
      />
      <label htmlFor={fileInputId}>
        <Button as="span" color="primary" {...buttonProps}>
          {label}
        </Button>
      </label>
    </div>
  );
};
