let notificationTimeouts = [];

function requestNotificationPermission() {
  if (!("Notification" in window)) {
    alert("Questo browser non supporta le notifiche desktop");
    return;
  }
  
  if (Notification.permission !== "denied" && Notification.permission !== "granted") {
    Notification.requestPermission();
  }
}

function clearAllNotifications() {
  notificationTimeouts.forEach(t => clearTimeout(t));
  notificationTimeouts = [];
}

function scheduleNotifications(settings, todayMeals, batchCookingNotes) {
  clearAllNotifications();

  if (!("Notification" in window) || Notification.permission !== "granted" || !settings.notificationsEnabled) {
    return;
  }

  const now = new Date();
  
  todayMeals.forEach(meal => {
    const timeStr = settings.notificationTimes[meal.slot];
    if (!timeStr) return;
    
    const [hours, minutes] = timeStr.split(':').map(Number);
    const mealTime = new Date();
    mealTime.setHours(hours, minutes, 0, 0);
    
    const timeDiff = mealTime.getTime() - now.getTime();
    
    if (timeDiff > 0) {
      const timeoutId = setTimeout(() => {
        let body = `${meal.name} — ${timeStr}`;
        
        new Notification(`${meal.emoji} È ora di: ${meal.slot.toUpperCase()}`, {
          body: body,
          icon: 'icons/icon-192.svg'
        });
      }, timeDiff);
      
      notificationTimeouts.push(timeoutId);

      // Schedule batch cooking reminder 30 mins after dinner
      if (meal.slot === 'dinner' && batchCookingNotes) {
        const batchDiff = timeDiff + (30 * 60 * 1000);
        if (batchDiff > 0) {
          const batchTimeoutId = setTimeout(() => {
            new Notification(`🍳 Promemoria Preparazione`, {
              body: batchCookingNotes,
              icon: 'icons/icon-192.svg'
            });
          }, batchDiff);
          notificationTimeouts.push(batchTimeoutId);
        }
      }
    }
  });

  // Schedule a midnight reset to reschedule for the next day
  const midnight = new Date();
  midnight.setHours(24, 0, 0, 0);
  const msToMidnight = midnight.getTime() - now.getTime();
  
  const midnightTimeoutId = setTimeout(() => {
    window.dispatchEvent(new CustomEvent('midnight-refresh'));
  }, msToMidnight);
  
  notificationTimeouts.push(midnightTimeoutId);
}
