// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { LogIn, LogOut, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/contexts/AuthContext";
import { isAuthEnabled } from "@/lib/auth/msalInstance";
import { cn } from "@/lib/utils";

/** Derive up to two uppercase initials from a display name or username. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Header account control: shows the signed-in user's initials with a dropdown
 * containing their name/username and a "Sign out" action. When signed out
 * (an edge/transitional state, since the app is gated) it offers "Sign in".
 */
export function UserMenu({ className }: { className?: string }) {
  const { user, isAuthenticated, login, logout } = useAuth();

  // Auth feature disabled → no account control in the header.
  if (!isAuthEnabled) {
    return null;
  }

  if (!isAuthenticated || !user) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className={cn("gap-2", className)}
        onClick={() => void login()}
      >
        <LogIn className="h-4 w-4" />
        Sign in
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn("h-8 w-8 rounded-full", className)}
          aria-label="Account menu"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-xs font-semibold text-foreground">
            {initialsOf(user.name)}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="flex items-center gap-2 font-normal">
          <User className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium">{user.name}</span>
            {user.username && (
              <span className="truncate text-xs text-muted-foreground">
                {user.username}
              </span>
            )}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="gap-2" onClick={() => void logout()}>
          <LogOut className="h-4 w-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
