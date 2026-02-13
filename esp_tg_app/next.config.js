/** @type {import('next').NextConfig} */
const nextConfig = {
  // ВЫНОСИМ ВСЕ В ОДИН ОБЪЕКТ
  output: 'standalone',
  
  // Отключаем телеметрию
  telemetry: false,
  
  // Уменьшаем нагрузку при билде
  swcMinify: true,
  
  // Таймауты для статической генерации
  staticPageGenerationTimeout: 120,
  
  // Настройки изображений
  images: {
    unoptimized: true,
  },
  
  // Хедеры (твои старые)
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'ngrok-skip-browser-warning',
            value: 'true',
          },
        ],
      },
    ];
  },
  
  // Environment переменные
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8005',
  },
};

module.exports = nextConfig; // Экспортируем один раз!