"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  return (
    <Hint label="Toggle theme">
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
        aria-label="Toggle theme"
      >
        <Sun className="hidden dark:block" />
        <Moon className="dark:hidden" />
      </Button>
    </Hint>
  );
}
