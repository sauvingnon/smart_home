import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Key, LogIn, AlertCircle } from 'lucide-react';

interface LoginProps {
  error?: string | null;  // 👈 Добавили проп
}

export const Login: React.FC<LoginProps> = ({ error }) => {
  const [key, setKey] = useState('');
  const [localError, setLocalError] = useState('');
  const { setAccessKey } = useAuth();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!key.trim()) {
      setLocalError('Введите ключ доступа');
      return;
    }
    
    setAccessKey(key.trim());
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 flex items-center justify-center p-4">
      <Card className="w-full max-w-md border-0 shadow-xl">
        <CardHeader>
          <CardTitle className="text-2xl flex items-center gap-3">
            <Key className="h-6 w-6 text-blue-500" />
            Доступ к управлению
          </CardTitle>
        </CardHeader>
        <CardContent>
          {/* 👇 Блок с ошибкой от бекенда */}
          {error && (
            <div className="mb-4 p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg flex items-start gap-2">
              <AlertCircle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm text-slate-600 dark:text-slate-400">
                Введите ключ доступа
              </label>
              <Input
                type="text"
                value={key}
                onChange={(e) => {
                  setKey(e.target.value);
                  setLocalError('');
                }}
                placeholder="например: abc123..."
                className="w-full"
                autoFocus
              />
              {localError && (
                <p className="text-sm text-red-500">{localError}</p>
              )}
            </div>
            
            <Button 
              type="submit"
              className="w-full bg-gradient-to-r from-blue-600 to-blue-500"
            >
              <LogIn className="h-4 w-4 mr-2" />
              Войти
            </Button>
            
            <p className="text-xs text-center text-slate-400 mt-4">
              Ключ можно получить в боте @my_tiny_smart_house_bot командой /getkey
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
};