"use client";

import { useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";

export function useUnsavedChangesWarning(hasChanges: boolean) {
  // Handle browser close/refresh
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasChanges) {
        e.preventDefault();
        e.returnValue = "";
        return "";
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasChanges]);

  // Create a navigation guard function
  const confirmNavigation = useCallback(
    (callback: () => void) => {
      if (hasChanges) {
        const confirmed = window.confirm(
          "You have unsaved changes. Are you sure you want to leave?"
        );
        if (confirmed) {
          callback();
        }
      } else {
        callback();
      }
    },
    [hasChanges]
  );

  return { confirmNavigation };
}
