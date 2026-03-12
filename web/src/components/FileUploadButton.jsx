import { useId } from "react";
import { Button } from "@nextui-org/react";

export const FileUploadButton = ({ label, onFileSelect, accept, inputId, buttonProps }) => {
  const generatedId = useId()
  const fileInputId = inputId ?? `file-input-${generatedId.replace(/:/g, "")}`

  const handleFileInput = (e) => {
    const file = e.target.files[0];
    if (file) {
      onFileSelect(file);
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
      />
      <label htmlFor={fileInputId}>
        <Button as="span" color="primary" {...buttonProps}>
          {label}
        </Button>
      </label>
    </div>
  );
};
